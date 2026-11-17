import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import type { LeadfloPatient, ListPatientsQuery } from "../src/leadflo/types.js";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.WF1_API_KEY = "test-wf1-key";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-received-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const { createApp } = await import("../src/app.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient } = await import("../src/leadflo/mockClient.js");

const dated: LeadfloPatient = {
  id: "hist-1",
  first_name: "Grace",
  last_name: "Hopper",
  email: "grace@example.com",
  phone: "07700900111",
  type: "General",
  source: "Google Ads",
  stage: "lost",
  created_at: "2026-08-02T09:00:00.000Z",
  labels: [],
};

describe("leads received", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;
  let calls: ListPatientsQuery[];
  let app: ReturnType<typeof createApp>;

  before(() => {
    store = new Store(dbPath);
    calls = [];
    const client = new MockLeadfloClient();
    client.listPatients = async (query) => {
      calls.push(query);
      return { patients: [{ ...dated }], total: 1, page: query.page ?? 1, limit: query.limit ?? 50 };
    };
    app = createApp({ store, poller: new Poller({ store, client }), client });
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("refuses the book without the feeder key", async () => {
    const res = await request(app).get("/api/report/leads-received").query({ from: "a", to: "b" });
    assert.equal(res.status, 401);
    assert.equal(store.listAllLeads().length, 0);
  });

  it("returns the overview list and does not store it", async () => {
    const res = await request(app)
      .get("/api/report/leads-received")
      .set("X-WF1-Key", "test-wf1-key")
      .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-11-17T23:59:59.999Z" });
    assert.equal(res.status, 200);
    assert.equal(res.body.complete, true);
    assert.equal(res.body.report, "overview/leadsReceived");
    assert.equal(res.body.leads.length, 1);
    assert.equal(res.body.leads[0].stage, "lost");
    assert.equal(res.body.leads[0].enquiredAt, "2026-08-02T09:00:00.000Z");
    assert.equal(store.listAllLeads().length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].report, "overview/leadsReceived");
    assert.equal(calls[0].stages, undefined);
    assert.equal(calls[0].sources, undefined);
    assert.equal(calls[0].labels, undefined);
    assert.equal(calls[0].types, undefined);
  });

  it("stops when the first page has rows and no enquiry date", async () => {
    const client = new MockLeadfloClient();
    client.listPatients = async () => ({
      patients: [{ ...dated, created_at: null }],
      total: 1,
      page: 1,
      limit: 50,
    });
    const bare = createApp({
      store,
      poller: new Poller({ store, client }),
      client,
    });
    const res = await request(bare)
      .get("/api/report/leads-received")
      .set("X-WF1-Key", "test-wf1-key")
      .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-11-17T23:59:59.999Z" });
    assert.equal(res.status, 422);
    assert.equal(res.body.complete, false);
    assert.equal(store.listAllLeads().length, 0);
  });
});
