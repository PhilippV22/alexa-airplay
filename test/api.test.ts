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
    process.env.AIRBRIDGE_HLS_ROOT = path.join(tmpRoot, "hls");
    process.env.AIRBRIDGE_DB_PATH = path.join(tmpRoot, "airbridge.sqlite");
    process.env.AIRBRIDGE_STREAM_BASE_URL = "https://stream.example.com";
    process.env.AIRBRIDGE_SESSION_SECRET = "test-session-secret";
    process.env.AIRBRIDGE_ADMIN_PASSWORD = "test-password";
    process.env.AIRBRIDGE_ADMIN_USER = "admin";
    process.env.AIRBRIDGE_SPAWN_PROCESSES = "false";
    process.env.AIRBRIDGE_ALEXA_INVOKE_MODE = "mock";
    process.env.AIRBRIDGE_SETUP_ENV_FILE = path.join(tmpRoot, "airbridge.env");
    process.env.AIRBRIDGE_SETUP_CLOUDFLARED_FILE = path.join(tmpRoot, "cloudflared.yml");
    process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_FILE = path.join(tmpRoot, "alexa-cookie.txt");
    process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_ENCRYPTED_FILE = path.join(tmpRoot, "airbridge_alexa_cookie");
    process.env.AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION = "false";
    process.env.AIRBRIDGE_ALEXA_COOKIE_WIZARD_MOCK = "true";

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
    delete process.env.AIRBRIDGE_HLS_ROOT;
    delete process.env.AIRBRIDGE_DB_PATH;
    delete process.env.AIRBRIDGE_STREAM_BASE_URL;
    delete process.env.AIRBRIDGE_SESSION_SECRET;
    delete process.env.AIRBRIDGE_ADMIN_PASSWORD;
    delete process.env.AIRBRIDGE_ADMIN_USER;
    delete process.env.AIRBRIDGE_SPAWN_PROCESSES;
    delete process.env.AIRBRIDGE_ALEXA_INVOKE_MODE;
    delete process.env.AIRBRIDGE_SETUP_ENV_FILE;
    delete process.env.AIRBRIDGE_SETUP_CLOUDFLARED_FILE;
    delete process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_FILE;
    delete process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_ENCRYPTED_FILE;
    delete process.env.AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION;
    delete process.env.AIRBRIDGE_ALEXA_COOKIE_WIZARD_MOCK;
  });

  it("requires auth for protected endpoints", async () => {
    const res = await request(bundle.app).get("/api/targets");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("blocks group activation on create with 409 GROUP_NATIVE_UNSUPPORTED", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const res = await agent.post("/api/targets").send({
      name: "Wohnzimmer Gruppe",
      type: "group",
      enabled: true,
      alexa_group_id: "amzn1.alexa.group.test",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("GROUP_NATIVE_UNSUPPORTED");
  });

  it("stores group target as blocked when created disabled", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const created = await agent.post("/api/targets").send({
      name: "Kueche",
      type: "group",
      enabled: false,
      alexa_group_id: "group-123",
    });

    expect(created.status).toBe(201);
    expect(created.body.target.status).toBe("blocked_group_native_unsupported");

    const updated = await agent
      .patch(`/api/targets/${created.body.target.id}`)
      .send({ enabled: true });

    expect(updated.status).toBe(409);
    expect(updated.body.error).toBe("GROUP_NATIVE_UNSUPPORTED");
  });

  it("writes setup config and persists it to setup env file", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const updateRes = await agent.put("/api/setup/config").send({
      values: {
        AIRBRIDGE_STREAM_BASE_URL: "https://updated.example.com",
        AIRBRIDGE_TRUST_PROXY: true,
        AIRBRIDGE_PORT: 3333,
      },
    });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.values.AIRBRIDGE_STREAM_BASE_URL).toBe("https://updated.example.com");

    const setupConfigRes = await agent.get("/api/setup/config");
    expect(setupConfigRes.status).toBe(200);
    expect(setupConfigRes.body.values.AIRBRIDGE_PORT).toBe("3333");

    const envFile = fs.readFileSync(process.env.AIRBRIDGE_SETUP_ENV_FILE as string, "utf8");
    expect(envFile).toContain("AIRBRIDGE_STREAM_BASE_URL=https://updated.example.com");
    expect(envFile).toContain("AIRBRIDGE_PORT=3333");
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

  it("completes alexa cookie wizard in mock mode", async () => {
    const agent = request.agent(bundle.app);

    await agent
      .post("/api/auth/login")
      .send({ username: "admin", password: "test-password" })
      .expect(200);

    const startRes = await agent.post("/api/setup/alexa-cookie/wizard/start").send({
      amazonPage: "amazon.de",
      proxyHost: "127.0.0.1",
      proxyPort: 3457,
    });

    expect(startRes.status).toBe(200);

    let status = "starting";
    for (let i = 0; i < 10; i += 1) {
      const statusRes = await agent.get("/api/setup/alexa-cookie/wizard/status");
      status = statusRes.body.state.status;
      if (status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(status).toBe("completed");

    const cookieFile = fs.readFileSync(process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_FILE as string, "utf8");
    expect(cookieFile).toContain("mock-cookie");
  });
});
