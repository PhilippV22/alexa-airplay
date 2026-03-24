import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AppBundle {
  app: import("express").Express;
  store: { close: () => void };
  processManager: { stopAll: () => void };
}

describe("airbridge api", () => {
  let tmpRoot = "";
  let bundle: AppBundle;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "airbridge-test-"));
    process.env.AIRBRIDGE_DATA_ROOT = path.join(tmpRoot, "var");
    process.env.AIRBRIDGE_RUN_ROOT = path.join(tmpRoot, "run");
    process.env.AIRBRIDGE_DB_PATH = path.join(tmpRoot, "airbridge.sqlite");
    process.env.AIRBRIDGE_SESSION_SECRET = "test-session-secret";
    process.env.AIRBRIDGE_ADMIN_PASSWORD = "test-password";
    process.env.AIRBRIDGE_ADMIN_USER = "admin";
    process.env.AIRBRIDGE_SPAWN_PROCESSES = "false";
    process.env.AIRBRIDGE_SETUP_ENV_FILE = path.join(tmpRoot, "airbridge.env");

    vi.resetModules();
    const server = await import("../src/server");
    bundle = (await server.createApp()) as AppBundle;
  });

  afterEach(() => {
    bundle.processManager.stopAll();
    bundle.store.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    delete process.env.AIRBRIDGE_DATA_ROOT;
    delete process.env.AIRBRIDGE_RUN_ROOT;
    delete process.env.AIRBRIDGE_DB_PATH;
    delete process.env.AIRBRIDGE_SESSION_SECRET;
    delete process.env.AIRBRIDGE_ADMIN_PASSWORD;
    delete process.env.AIRBRIDGE_ADMIN_USER;
    delete process.env.AIRBRIDGE_SPAWN_PROCESSES;
    delete process.env.AIRBRIDGE_SETUP_ENV_FILE;
  });

  it("requires auth for protected endpoints", async () => {
    const res = await request(bundle.app).get("/api/targets");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("creates and lists a bluetooth target", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const created = await agent.post("/api/targets").send({
      name: "Wohnzimmer Echo",
      type: "bluetooth",
      bluetooth_mac: "AA:BB:CC:DD:EE:FF",
      enabled: false,
    });

    expect(created.status).toBe(201);
    expect(created.body.target.type).toBe("bluetooth");
    expect(created.body.target.bluetooth_mac).toBe("AA:BB:CC:DD:EE:FF");
    expect(created.body.target.status).toBe("disabled");

    const listRes = await agent.get("/api/targets");
    expect(listRes.status).toBe(200);
    expect(listRes.body.targets).toHaveLength(1);
  });

  it("enables and disables a target via patch", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const created = await agent.post("/api/targets").send({
      name: "Schlafzimmer Echo",
      type: "bluetooth",
      bluetooth_mac: "11:22:33:44:55:66",
      enabled: false,
    });

    expect(created.status).toBe(201);
    const id = created.body.target.id as number;

    const enabled = await agent.patch(`/api/targets/${id}`).send({ enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.target.status).toBe("active");

    const disabled = await agent.patch(`/api/targets/${id}`).send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.target.status).toBe("disabled");
  });

  it("deletes a target", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const created = await agent.post("/api/targets").send({
      name: "Kueche Echo",
      type: "bluetooth",
      bluetooth_mac: "AA:BB:CC:DD:EE:01",
      enabled: false,
    });

    expect(created.status).toBe(201);
    const id = created.body.target.id as number;

    const del = await agent.delete(`/api/targets/${id}`);
    expect(del.status).toBe(204);

    const listRes = await agent.get("/api/targets");
    expect(listRes.body.targets).toHaveLength(0);
  });

  it("writes setup config and persists it to env file", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const updateRes = await agent.put("/api/setup/config").send({
      values: {
        AIRBRIDGE_PORT: 3333,
        AIRBRIDGE_TRUST_PROXY: true,
        AIRBRIDGE_FFMPEG_BITRATE: "128k",
      },
    });

    expect(updateRes.status).toBe(200);

    const configRes = await agent.get("/api/setup/config");
    expect(configRes.status).toBe(200);
    expect(configRes.body.values.AIRBRIDGE_PORT).toBe("3333");

    const envFile = fs.readFileSync(process.env.AIRBRIDGE_SETUP_ENV_FILE as string, "utf8");
    expect(envFile).toContain("AIRBRIDGE_PORT=3333");
    expect(envFile).toContain("AIRBRIDGE_FFMPEG_BITRATE=128k");
  });

  it("updates admin password as hash via setup endpoint", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const res = await agent.post("/api/setup/admin-password").send({
      password: "new-password-1234",
    });

    expect(res.status).toBe(200);

    const envFile = fs.readFileSync(process.env.AIRBRIDGE_SETUP_ENV_FILE as string, "utf8");
    expect(envFile).toContain("AIRBRIDGE_ADMIN_PASSWORD_HASH=");
    expect(envFile).not.toContain("AIRBRIDGE_ADMIN_PASSWORD=");
  });

  it("GET /health/setup returns setup status without auth", async () => {
    const res = await request(bundle.app).get("/health/setup");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("shairportBin");
    expect(res.body).toHaveProperty("ffmpegBin");
    expect(res.body).toHaveProperty("activeTargets");
    expect(res.body.activeTargets.ok).toBe(false);
    expect(res.body.activeTargets.count).toBe(0);
  });

  it("GET /health/live returns ok without auth", async () => {
    const res = await request(bundle.app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
