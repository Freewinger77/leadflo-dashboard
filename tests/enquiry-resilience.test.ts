import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-resilience-${Date.now()}.db`);

const { Store } = await import("../src/db/store.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient } = await import("../src/leadflo/mockClient.js");

describe("enquiry backfill cannot break discovery", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;

  before(() => {
    store = new Store(dbPath);
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("still discovers and records leads when the backfill throws", async () => {
    // This is the regression: a failure in the enquiry-date step took the whole
    // poll down, so no leads were discovered and none were handed to the webhook.
    const broken = Object.create(store) as typeof store;
    broken.listLeadsMissingEnquiryDate = () => {
      throw new Error("no such column: timeline_fetched_at");
    };

    const poller = new Poller({
      store: broken,
      client: new MockLeadfloClient(),
      publicBaseUrl: "http://localhost:8788",
    });

    const result = await poller.tick();

    assert.equal(result.discovered, 5, "leads should still be discovered");
    assert.equal(result.newLeads, 5);
    assert.equal(result.dated, 0);
    assert.equal(store.listAllLeads().length, 5);

    const latest = store.latestPollRun();
    assert.equal(latest?.ok, 1, "the poll should be recorded as successful");
    assert.equal(latest?.error, null);
  });

  it("repairs a database that predates the enquiry columns", async () => {
    // A deploy can leave code running against an older schema. Rather than throw
    // on every poll, the columns are added on demand.
    store.db.exec("ALTER TABLE leads DROP COLUMN enquired_at");
    store.db.exec("ALTER TABLE leads DROP COLUMN timeline_fetched_at");
    assert.throws(() => store.listLeadsMissingEnquiryDate(5), /no such column/);

    const poller = new Poller({
      store,
      client: new MockLeadfloClient(),
      publicBaseUrl: "http://localhost:8788",
    });
    const result = await poller.tick();

    assert.doesNotThrow(() => store.listLeadsMissingEnquiryDate(5));
    assert.equal(store.latestPollRun()?.ok, 1);
    assert.ok(result.dated >= 1, "and the enquiry date is resolved once repaired");
    assert.ok(store.getLead("mock-asif-test")?.enquired_at);
  });
});
