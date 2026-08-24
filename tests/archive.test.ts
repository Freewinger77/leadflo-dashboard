import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import request from "supertest";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.WF1_API_KEY = "test-wf1-key";
process.env.NOTES_ONLY_TEST_NAMES = "false";
process.env.OUTBOUND_ALLOWLIST_ONLY = "false";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-archive-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const { createApp } = await import("../src/app.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient } = await import("../src/leadflo/mockClient.js");
const { normalizePatient } = await import("../src/leadflo/index.js");
const { ArchiveScraper } = await import("../src/services/archive.js");

describe("lead archive", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;
  let app: ReturnType<typeof createApp>;
  let client: InstanceType<typeof MockLeadfloClient>;

  before(() => {
    store = new Store(dbPath);
    client = new MockLeadfloClient();
    const poller = new Poller({ store, client });
    app = createApp({ store, poller, client });
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("normalizePatient maps pipeline rows", () => {
    const lead = normalizePatient({
      id: "p-1",
      first_name: "Ada",
      last_name: "Lovelace",
      phone: "+447700900111",
      email: "ada@example.com",
      type: "Implant",
      source: "Google Ads",
      stage: "consultation",
      labels: ["VIP"],
    });
    assert.ok(lead);
    assert.equal(lead!.patientId, "p-1");
    assert.equal(lead!.treatmentType, "Implant");
    assert.equal(lead!.stage, "consultation");
    assert.equal(lead!.fullName, "Ada Lovelace");
  });

  it("archive scrape upserts every mock patient without webhooks", async () => {
    const scraper = new ArchiveScraper(store, client);
    const result = await scraper.scrape({
      from: "2020-01-01",
      to: "2030-01-01",
    });
    assert.equal(result.ok, true);
    assert.ok(result.fetched >= 5);
    assert.ok(result.created >= 5);
    assert.equal(store.listAllLeads().length >= 5, true);
    assert.ok(
      store.listAllLeads().some((l) => /whitening/i.test(l.treatment_type)),
    );
  });

  it("queryLeads filters by type and search", () => {
    const { leads, total } = store.queryLeads({ type: "Implant", limit: 100 });
    assert.ok(total >= 1);
    assert.ok(leads.every((l) => /implant/i.test(l.treatment_type)));

    const hit = store.queryLeads({ q: "asif", limit: 50 });
    assert.ok(hit.leads.some((l) => /asif/i.test(l.full_name)));
  });

  it("GET /api/archive/leads returns facets", async () => {
    const res = await request(app)
      .get("/api/archive/leads?limit=500")
      .set("X-WF1-Key", "test-wf1-key")
      .expect(200);
    assert.ok(Array.isArray(res.body.leads));
    assert.ok(res.body.facets?.byType);
    assert.ok(res.body.total >= res.body.leads.length);
  });

  it("POST /api/archive/scrape requires WF-1 key", async () => {
    await request(app).post("/api/archive/scrape").send({}).expect(401);
    const res = await request(app)
      .post("/api/archive/scrape")
      .set("X-WF1-Key", "test-wf1-key")
      .send({ from: "2020-01-01", to: "2030-01-01" })
      .expect(200);
    assert.equal(res.body.ok, true);
  });
});
