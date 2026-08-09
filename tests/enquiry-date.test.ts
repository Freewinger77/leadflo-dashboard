import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-enquiry-${Date.now()}.db`);

const { enquiryDateFromTimeline } = await import("../src/leadflo/enquiryDate.js");
const { Store } = await import("../src/db/store.js");
const { Poller } = await import("../src/services/poller.js");
const { MockLeadfloClient } = await import("../src/leadflo/mockClient.js");

describe("enquiryDateFromTimeline", () => {
  it("uses the form submission that created the lead", () => {
    const at = enquiryDateFromTimeline([
      { id: "n", type: "note", datetime: "2023-02-01T09:00:00.000000Z" },
      { id: "f", type: "form_submission", datetime: "2023-01-03T21:17:27.000000Z" },
      { id: "c", type: "communication", datetime: "2023-01-04T09:11:52.000000Z" },
    ]);
    assert.equal(at, "2023-01-03T21:17:27.000Z");
  });

  it("ignores an earlier contact so a lead is not dated before it existed", () => {
    // Real case: a patient already known to the practice has a call on file
    // predating the enquiry that created the lead.
    const at = enquiryDateFromTimeline([
      { id: "c", type: "communication", datetime: "2022-12-23T15:31:47.000000Z" },
      { id: "f", type: "form_submission", datetime: "2023-01-09T10:13:35.000000Z" },
    ]);
    assert.equal(at, "2023-01-09T10:13:35.000Z");
  });

  it("falls back to the oldest entry when there is no form submission", () => {
    const at = enquiryDateFromTimeline([
      { id: "b", type: "note", datetime: "2024-05-02T10:00:00.000Z" },
      { id: "a", type: "communication", datetime: "2024-05-01T10:00:00.000Z" },
    ]);
    assert.equal(at, "2024-05-01T10:00:00.000Z");
  });

  it("handles the offset format Leadflo also returns", () => {
    const at = enquiryDateFromTimeline([
      { id: "f", type: "form_submission", datetime: "2023-01-10T00:00:00.000+00:00" },
    ]);
    assert.equal(at, "2023-01-10T00:00:00.000Z");
  });

  it("returns null rather than a guess when there is nothing usable", () => {
    assert.equal(enquiryDateFromTimeline([]), null);
    assert.equal(enquiryDateFromTimeline(null), null);
    assert.equal(
      enquiryDateFromTimeline([{ id: "x", type: "note", datetime: "not a date" }]),
      null,
    );
  });
});

describe("enquiry date backfill", () => {
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

  it("dates a lead from its timeline rather than from the scrape", async () => {
    const result = await poller.tick();
    assert.ok(result.dated >= 1);

    const lead = store.getLead("mock-asif-test");
    assert.ok(lead?.enquired_at, "expected an enquiry date");
    assert.notEqual(lead!.enquired_at, lead!.first_seen_at);
    // The fixture's form submission is a day before the scrape.
    assert.ok(lead!.enquired_at! < lead!.first_seen_at);
  });

  it("does not retry leads whose timeline held no date", async () => {
    // Fixtures other than mock-asif-test have empty timelines. They must still
    // be marked as attempted, or they would be re-fetched on every single tick.
    const withoutDate = store
      .listAllLeads()
      .filter((row) => !row.enquired_at);
    assert.ok(withoutDate.length > 0, "expected fixtures with no timeline");
    for (const row of withoutDate) {
      assert.ok(row.timeline_fetched_at, `${row.patient_id} was not marked attempted`);
    }
    assert.equal(store.listLeadsMissingEnquiryDate(50).length, 0);
  });

  it("keeps a known enquiry date if a later read finds nothing", () => {
    const before = store.getLead("mock-asif-test")!.enquired_at;
    store.setEnquiryDate("mock-asif-test", null);
    assert.equal(store.getLead("mock-asif-test")!.enquired_at, before);
  });
});
