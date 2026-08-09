import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.LEADFLO_MODE = "mock";
process.env.OUTBOUND_ENABLED = "false";
process.env.OUTBOUND_ALLOWLIST = "";
process.env.WF1_API_KEY = "test-key";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-settings-${Date.now()}.db`);

const { Store } = await import("../src/db/store.js");
const { config } = await import("../src/config.js");
const { clearOverride, effective, loadOverrides, setOverride } = await import(
  "../src/runtime-settings.js"
);
const { createApp } = await import("../src/app.js");

let store: InstanceType<typeof Store>;
let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

before(async () => {
  store = new Store();
  const app = createApp({
    store,
    poller: { tick: async () => ({}) } as never,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => {
  server?.close();
  store?.close?.();
  fs.rmSync(process.env.DATABASE_PATH!, { force: true });
});

describe("runtime settings overlay", () => {
  it("falls back to the environment when nothing is stored", () => {
    clearOverride("OUTBOUND_ENABLED");
    assert.equal(config.outbound.enabled, false);
    assert.equal(effective("OUTBOUND_ENABLED").source, "environment");
  });

  it("lets a stored override win over the environment", () => {
    setOverride("OUTBOUND_ENABLED", "true");
    assert.equal(
      config.outbound.enabled,
      true,
      "the running service must honour the override without a restart",
    );
    assert.equal(effective("OUTBOUND_ENABLED").source, "runtime");
    clearOverride("OUTBOUND_ENABLED");
    assert.equal(config.outbound.enabled, false, "clearing hands it back to the env");
  });

  it("survives a restart by reloading what was persisted", () => {
    store.setSetting("OUTBOUND_ALLOWLIST", "447700900123");
    loadOverrides(store.allSettings());
    assert.deepEqual(config.outbound.allowlist, ["447700900123"]);
    store.deleteSetting("OUTBOUND_ALLOWLIST");
    loadOverrides(store.allSettings());
  });

  it("ignores keys that were never meant to be overridable", () => {
    loadOverrides({ WF1_API_KEY: "stolen", OUTBOUND_ENABLED: "true" });
    assert.equal(config.outbound.apiKey, "test-key", "the key stays an env-only secret");
    loadOverrides({});
  });
});

describe("settings endpoint", () => {
  it("refuses to read or write without the WF-1 key", async () => {
    const read = await fetch(`${baseUrl}/api/settings/outbound`);
    assert.equal(read.status, 401, "the allowlist must not be readable by the public");

    const write = await fetch(`${baseUrl}/api/settings/outbound`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ OUTBOUND_ENABLED: "true" }),
    });
    assert.equal(write.status, 401, "nobody may switch on sending anonymously");
    assert.equal(config.outbound.enabled, false, "and nothing changed");
  });

  it("applies an authorised change immediately and persists it", async () => {
    const response = await fetch(`${baseUrl}/api/settings/outbound`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-wf1-key": "test-key" },
      body: JSON.stringify({
        OUTBOUND_ENABLED: "true",
        OUTBOUND_ALLOWLIST: "+44 7700 900456",
      }),
    });
    assert.equal(response.status, 200);

    assert.equal(config.outbound.enabled, true);
    assert.deepEqual(
      config.outbound.allowlist,
      ["447700900456"],
      "the number is normalised to digits, as the matcher compares msisdns",
    );
    assert.equal(
      store.getSetting("OUTBOUND_ENABLED"),
      "true",
      "and it is on disk, so a restart keeps it",
    );
  });

  it("hands a setting back to the environment when cleared with null", async () => {
    const response = await fetch(`${baseUrl}/api/settings/outbound`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-wf1-key": "test-key" },
      body: JSON.stringify({ OUTBOUND_ENABLED: null }),
    });
    assert.equal(response.status, 200);
    assert.equal(config.outbound.enabled, false);
    assert.equal(store.getSetting("OUTBOUND_ENABLED"), undefined);
  });

  it("rejects keys outside the overridable set", async () => {
    const response = await fetch(`${baseUrl}/api/settings/outbound`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-wf1-key": "test-key" },
      body: JSON.stringify({ WF1_API_KEY: "stolen" }),
    });
    assert.equal(response.status, 400);
    assert.equal(config.outbound.apiKey, "test-key");
  });
});
