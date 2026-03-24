import Database from "better-sqlite3";
import {
  AuditLog,
  CreateTargetInput,
  Target,
  TargetStatus,
  UpdateTargetInput,
} from "./types";

type AuditResult = "success" | "failure";

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('bluetooth')),
        bluetooth_mac TEXT,
        airplay_name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('active', 'error', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id INTEGER,
        result TEXT NOT NULL CHECK(result IN ('success', 'failure')),
        details_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_targets_enabled ON targets(enabled);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);

    // Migration: drop Alexa columns and sessions table if they exist (from older schema)
    const cols = (this.db.prepare("PRAGMA table_info(targets)").all() as { name: string }[]).map(
      (c) => c.name,
    );

    const needsMigration = cols.includes("alexa_device_id") || cols.includes("alexa_group_id");
    if (needsMigration) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS targets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          bluetooth_mac TEXT,
          airplay_name TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO targets_new (id, name, type, bluetooth_mac, airplay_name, enabled, status, created_at, updated_at)
          SELECT id, name,
            CASE WHEN type = 'bluetooth' THEN 'bluetooth' ELSE 'bluetooth' END,
            bluetooth_mac, airplay_name, enabled,
            CASE WHEN status IN ('active', 'error', 'disabled') THEN status ELSE 'disabled' END,
            created_at, updated_at
          FROM targets;
        DROP TABLE targets;
        ALTER TABLE targets_new RENAME TO targets;
        DROP TABLE IF EXISTS sessions;
        COMMIT;
      `);
    } else {
      this.db.exec("DROP TABLE IF EXISTS sessions");
    }
  }

  listTargets(): Target[] {
    const stmt = this.db.prepare("SELECT * FROM targets ORDER BY id ASC");
    return stmt.all() as Target[];
  }

  getTarget(targetId: number): Target | undefined {
    const stmt = this.db.prepare("SELECT * FROM targets WHERE id = ?");
    return stmt.get(targetId) as Target | undefined;
  }

  listEnabledTargets(): Target[] {
    const stmt = this.db.prepare(
      `SELECT * FROM targets WHERE enabled = 1 AND status = 'active' ORDER BY id ASC`,
    );
    return stmt.all() as Target[];
  }

  createTarget(input: CreateTargetInput): Target {
    const now = new Date().toISOString();
    const enabled = input.enabled ?? false;
    const status: TargetStatus = enabled ? "active" : "disabled";

    const insertStmt = this.db.prepare(`
      INSERT INTO targets (
        name, type, bluetooth_mac, airplay_name,
        enabled, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      input.name,
      input.type,
      input.bluetooth_mac ?? null,
      input.airplay_name ?? `AirBridge ${input.name}`,
      enabled ? 1 : 0,
      status,
      now,
      now,
    );

    const created = this.getTarget(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Failed to load created target");
    }
    return created;
  }

  updateTarget(targetId: number, patch: UpdateTargetInput): Target | undefined {
    const current = this.getTarget(targetId);
    if (!current) {
      return undefined;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      values.push(patch.name);
    }

    if (patch.bluetooth_mac !== undefined) {
      updates.push("bluetooth_mac = ?");
      values.push(patch.bluetooth_mac);
    }

    if (patch.airplay_name !== undefined) {
      updates.push("airplay_name = ?");
      values.push(patch.airplay_name);
    }

    if (patch.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }

    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }

    updates.push("updated_at = ?");
    values.push(new Date().toISOString());

    const sql = `UPDATE targets SET ${updates.join(", ")} WHERE id = ?`;
    values.push(targetId);
    this.db.prepare(sql).run(...values);

    return this.getTarget(targetId);
  }

  deleteTarget(targetId: number): boolean {
    const result = this.db.prepare("DELETE FROM targets WHERE id = ?").run(targetId);
    return result.changes > 0;
  }

  addAudit(
    actor: string,
    action: string,
    targetId: number | null,
    result: AuditResult,
    details: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (actor, action, target_id, result, details_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(actor, action, targetId, result, JSON.stringify(details), new Date().toISOString());
  }

  listAudit(limit = 300): AuditLog[] {
    return this.db
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as AuditLog[];
  }
}
