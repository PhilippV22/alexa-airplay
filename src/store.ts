import Database from "better-sqlite3";
import {
  AuditLog,
  CreateTargetInput,
  ErrorCode,
  Session,
  SessionState,
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
        type TEXT NOT NULL CHECK(type IN ('device', 'group')),
        alexa_device_id TEXT,
        alexa_group_id TEXT,
        airplay_name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('active', 'blocked_group_native_unsupported', 'error', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('idle', 'buffering', 'playing', 'stopped', 'error')),
        stream_url TEXT NOT NULL,
        stream_token TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error_code TEXT CHECK(error_code IN ('GROUP_NATIVE_UNSUPPORTED', 'ALEXA_AUTH_FAILED', 'ALEXA_INVOKE_FAILED', 'TUNNEL_UNAVAILABLE', 'TRANSCODER_FAILED')),
        FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE CASCADE
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

      CREATE INDEX IF NOT EXISTS idx_targets_type_enabled ON targets(type, enabled);
      CREATE INDEX IF NOT EXISTS idx_sessions_target ON sessions(target_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(stream_token);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(ended_at);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);
  }

  listTargets(): Target[] {
    const stmt = this.db.prepare("SELECT * FROM targets ORDER BY id ASC");
    return stmt.all() as Target[];
  }

  getTarget(targetId: number): Target | undefined {
    const stmt = this.db.prepare("SELECT * FROM targets WHERE id = ?");
    return stmt.get(targetId) as Target | undefined;
  }

  listEnabledDeviceTargets(): Target[] {
    const stmt = this.db.prepare(
      `SELECT * FROM targets
       WHERE type = 'device' AND enabled = 1 AND status = 'active'
       ORDER BY id ASC`,
    );
    return stmt.all() as Target[];
  }

  createTarget(input: CreateTargetInput): Target {
    const now = new Date().toISOString();
    const isGroup = input.type === "group";
    const enabled = input.enabled ?? false;
    const status: TargetStatus = isGroup
      ? "blocked_group_native_unsupported"
      : enabled
        ? "active"
        : "disabled";

    const insertStmt = this.db.prepare(`
      INSERT INTO targets (
        name, type, alexa_device_id, alexa_group_id, airplay_name,
        enabled, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      input.name,
      input.type,
      input.alexa_device_id ?? null,
      input.alexa_group_id ?? null,
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

    if (patch.alexa_device_id !== undefined) {
      updates.push("alexa_device_id = ?");
      values.push(patch.alexa_device_id);
    }

    if (patch.alexa_group_id !== undefined) {
      updates.push("alexa_group_id = ?");
      values.push(patch.alexa_group_id);
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

  createSession(
    targetId: number,
    streamUrl: string,
    streamToken: string,
    state: SessionState = "buffering",
    errorCode: ErrorCode | null = null,
  ): Session {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (target_id, state, stream_url, stream_token, started_at, ended_at, error_code)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);

    const result = stmt.run(targetId, state, streamUrl, streamToken, now, errorCode);
    const created = this.getSession(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error("Failed to create session");
    }
    return created;
  }

  getSession(sessionId: number): Session | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Session | undefined;
  }

  listSessions(limit = 200): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT ?")
      .all(limit) as Session[];
  }

  listActiveSessions(): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id DESC")
      .all() as Session[];
  }

  getActiveSessionByTarget(targetId: number): Session | undefined {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE target_id = ? AND ended_at IS NULL
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(targetId) as Session | undefined;
  }

  getSessionByToken(token: string): Session | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE stream_token = ? ORDER BY id DESC LIMIT 1")
      .get(token) as Session | undefined;
  }

  updateSessionState(sessionId: number, state: SessionState, errorCode: ErrorCode | null = null): void {
    this.db
      .prepare("UPDATE sessions SET state = ?, error_code = ? WHERE id = ?")
      .run(state, errorCode, sessionId);
  }

  finishSessionByToken(token: string, state: SessionState, errorCode: ErrorCode | null = null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE sessions SET state = ?, error_code = ?, ended_at = COALESCE(ended_at, ?) WHERE stream_token = ?",
      )
      .run(state, errorCode, now, token);
  }

  finishActiveSessionByTarget(
    targetId: number,
    state: SessionState,
    errorCode: ErrorCode | null = null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions
         SET state = ?, error_code = ?, ended_at = COALESCE(ended_at, ?)
         WHERE target_id = ? AND ended_at IS NULL`,
      )
      .run(state, errorCode, now, targetId);
  }

  countActiveSessions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE ended_at IS NULL").get() as {
      count: number;
    };
    return row.count;
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
