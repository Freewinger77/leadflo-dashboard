import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// A new lead's webhook can end in a WhatsApp message, so the cap is what stops a
// mass rediscovery becoming a mass send. Set to 2 with 3 webhook-eligible
// fixtures, so one lead has to be held back.
process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.WEBHOOK_DISPATCH_CAP_PER_TICK = "2";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-cap-${Date.now()}.db`);

const { Store } = await import("../src/db/store.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient } = await import("../src/leadflo/mockClient.js");

describe("webhook dispatch cap", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;
  let poller: InstanceType<typeof Poller>;

  before(() => {
    store = new Store(dbPath);
    poller = new Poller({
      store,
      client: new MockLeadfloClient(),
      publicBaseUrl: "http://localhost:8788",
    });
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  const sentCount = () =>
    store.listAllLeads().filter((row) => row.webhook_sent_at).length;
  const pendingCount = () =>
    store.listAllLeads().filter((row) => row.status === "webhook_pending").length;

  it("paces a burst instead of dispatching all of it at once", async () => {
    const first = await poller.tick();

    // All five fixtures are tracked, but only the three implants at contactable
    // stages are webhook-eligible, and the cap allows two of them.
    assert.equal(first.newLeads, 5);
    assert.equal(sentCount(), 2);
    assert.equal(pendingCount(), 1);
  });

  it("drains what it held back on the next tick, so nothing is dropped", async () => {
    const second = await poller.tick();

    assert.equal(second.newLeads, 0);
    assert.equal(sentCount(), 3);
    assert.equal(pendingCount(), 0);
  });

  it("stays settled once the backlog is clear", async () => {
    await poller.tick();

    assert.equal(sentCount(), 3);
    assert.equal(pendingCount(), 0);
  });
});
