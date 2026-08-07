import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import request from "supertest";

// Force mock mode before importing app modules that read config
process.env.LEADFLO_MODE = "mock";
process.env.NOTES_ONLY_TEST_NAMES = "true";
process.env.WEBHOOK_URL = "";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-test-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const { createApp } = await import("../src/app.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient, mockNotes } = await import(
  "../src/leadflo/mockClient.js"
);

describe("implant tracking flow", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;
  let app: ReturnType<typeof createApp>;
  let client: InstanceType<typeof MockLeadfloClient>;

  before(() => {
    store = new Store(dbPath);
    client = new MockLeadfloClient();
    const poller = new Poller({ store, client, publicBaseUrl: "http://localhost:8788" });
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

  it("tracks all lead types but webhooks only implants", async () => {
    const poll = await request(app).post("/api/poll").expect(200);
    // mock fixtures across scrape stages: 3 Implant + Whitening + Aligners
    assert.equal(poll.body.discovered, 5);
    assert.equal(poll.body.newLeads, 5);

    const leads = await request(app).get("/api/leads").expect(200);
    assert.equal(leads.body.leads.length, 5);
    assert.ok(leads.body.leads.some((l: { fullName: string }) => l.fullName === "asif test"));
    assert.ok(
      leads.body.leads.some((l: { treatmentType: string }) => l.treatmentType === "Whitening"),
    );
  });

  it("writes notes only for test-named leads by default", async () => {
    mockNotes.length = 0;

    const skipped = await request(app)
      .post("/api/webhooks/ai-response")
      .send({
        patientId: "mock-real-patient",
        note: "Hello Jane — this should not hit Leadflo",
      })
      .expect(200);
    assert.equal(skipped.body.status, "note_skipped");
    assert.equal(mockNotes.length, 0);

    const written = await request(app)
      .post("/api/webhooks/ai-response")
      .send({
        patientId: "mock-asif-test",
        note: "AI follow-up for asif test implant enquiry",
      })
      .expect(200);
    assert.equal(written.body.status, "note_written");
    assert.equal(mockNotes.length, 1);
    assert.equal(mockNotes[0]?.patientId, "mock-asif-test");
    assert.match(mockNotes[0]?.content ?? "", /AI follow-up/);
  });

  it("second poll does not re-webhook existing leads", async () => {
    const second = await request(app).post("/api/poll").expect(200);
    assert.equal(second.body.discovered, 5);
    assert.equal(second.body.newLeads, 0);
  });

  it("exposes analytics and lead timeline notes", async () => {
    const analytics = await request(app).get("/api/analytics?days=30").expect(200);
    assert.ok(Array.isArray(analytics.body.leadsPerDay));
    assert.ok(Array.isArray(analytics.body.byType));
    assert.ok(analytics.body.totals.discovered >= 5);

    const timeline = await request(app)
      .get("/api/leads/mock-asif-test/timeline")
      .expect(200);
    assert.ok(timeline.body.notes.length >= 1);
    assert.ok(timeline.body.newNotes.length >= 1);

    const again = await request(app)
      .get("/api/leads/mock-asif-test/timeline")
      .expect(200);
    assert.equal(again.body.newNotes.length, 0);
    assert.ok(again.body.oldNotes.length >= 1);
  });
});
