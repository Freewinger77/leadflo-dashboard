import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { NormalizedLead } from "../src/leadflo/types.js";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.OUTBOUND_ENABLED = "false";
process.env.OUTBOUND_ALLOWLIST_ONLY = "false";
process.env.REACTIVATION_ENABLED = "false";
process.env.REACTIVATION_ALLOWLIST_ONLY = "false";
process.env.REACTIVATION_MAX_PER_RUN = "10";
process.env.REACTIVATION_MAX_NEW_PER_DAY = "10";
process.env.REACTIVATION_MAX_FOLLOWUPS_PER_DAY = "10";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-reactivation-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const {
  claimReactivation,
  firstMessage,
  followupMessage,
  importDiscardReasons,
  importReactivationPeople,
  selectReactivation,
} = await import("../src/services/reactivation.js");
const { config } = await import("../src/config.js");

const REASON = "Did not respond to contact";

function lead(
  overrides: Partial<NormalizedLead> & { patientId: string },
): NormalizedLead {
  return {
    firstName: "Sam",
    lastName: overrides.patientId,
    fullName: `Sam ${overrides.patientId}`,
    phone: "+447700900000",
    email: `${overrides.patientId}@example.com`,
    treatmentType: "Implant",
    source: "Google Ads",
    stage: "maybeFuture",
    dueDate: null,
    labels: [],
    isTestName: false,
    scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("reactivation copy", () => {
  it("uses the approved first message with the first name", () => {
    assert.equal(
      firstMessage("amanda"),
      "Hi Amanda, it's Poppy from Dental Aesthetica. You enquired with us a while back about dental implants, and we never managed to catch you. Are you still thinking about replacing a missing tooth, or a few teeth? I can help with prices, finance options and the next step",
    );
  });

  it("uses the approved follow-up verbatim", () => {
    assert.equal(
      followupMessage(),
      "Just a quick follow-up, If dental implants are still on your mind, I'm happy to help. Would you like me to check some consultation times for you?",
    );
  });
});

describe("reactivation candidate selection", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;

  before(() => {
    store = new Store(dbPath);
    store.upsertScrapedLead(
      lead({ patientId: "no-reason", phone: "+447700900001", enquiredAt: "2026-03-01T10:00:00.000Z" }),
    );
    store.upsertScrapedLead(
      lead({
        patientId: "wrong-reason",
        phone: "+447700900002",
        enquiredAt: "2026-06-01T10:00:00.000Z",
      }),
    );
    store.setDiscardReason("wrong-reason", "Can't afford treatment right now");
    store.upsertScrapedLead(
      lead({ patientId: "ready", phone: "+447700900003", enquiredAt: "2025-09-25T09:00:00.000Z" }),
    );
    store.upsertScrapedLead(
      lead({
        patientId: "too-old",
        phone: "+447700900007",
        enquiredAt: "2024-06-01T10:00:00.000Z",
      }),
    );
    store.upsertScrapedLead(lead({ patientId: "undated", phone: "+447700900008" }));
    store.upsertScrapedLead(
      lead({
        patientId: "already-out",
        phone: "+447700900004",
        enquiredAt: "2025-10-01T10:00:00.000Z",
      }),
    );
    store.lockOutboundBatch(["already-out"], "wf1-old");
    store.recordOutboundResult("already-out", {
      batchId: "wf1-old",
      status: "sent",
      msisdn: "447700900004",
    });
    store.upsertScrapedLead(
      lead({
        patientId: "ortho",
        treatmentType: "Ortho",
        phone: "+447700900005",
        enquiredAt: "2025-10-01T10:00:00.000Z",
      }),
    );
    store.upsertScrapedLead(
      lead({
        patientId: "working",
        stage: "working",
        phone: "+447700900006",
        enquiredAt: "2025-10-01T10:00:00.000Z",
      }),
    );
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("takes every implant maybe-future in the last year, oldest first", () => {
    const { selected, skipped } = selectReactivation(store, "first", 10);
    const reasonFor = (id: string) =>
      skipped.find((s) => s.patientId === id)?.reason ?? "";

    assert.equal(reasonFor("too-old"), "enquired before reactivation window");
    assert.equal(reasonFor("undated"), "enquiry date unknown");
    assert.match(reasonFor("already-out"), /already contacted/);
    assert.match(reasonFor("ortho"), /not implant/);
    assert.match(reasonFor("working"), /not maybeFuture/);
    assert.deepEqual(
      selected.map((c) => c.patientId),
      ["ready", "no-reason", "wrong-reason"],
    );
    assert.equal(selected[0]?.message.startsWith("Hi Sam,"), true);
  });

  it("keeps only the oldest N in the first-touch pool", () => {
    process.env.REACTIVATION_MAX_POOL = "2";
    const { selected, skipped } = selectReactivation(store, "first", 10);
    process.env.REACTIVATION_MAX_POOL = "100";
    assert.deepEqual(
      selected.map((c) => c.patientId),
      ["ready", "no-reason"],
    );
    assert.equal(
      skipped.find((s) => s.patientId === "wrong-reason")?.reason,
      "outside oldest 2 pool",
    );
  });

  it("refuses claim while reactivation is off", () => {
    const result = claimReactivation(store, "first", 10);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /REACTIVATION_ENABLED is false/);
    assert.equal(store.getLead("ready")?.reactivation_status, null);
  });

  it("claims only after the switch is on", () => {
    process.env.REACTIVATION_ENABLED = "true";
    assert.equal(config.reactivation.enabled, true);
    const result = claimReactivation(store, "first", 10);
    assert.equal(result.ok, true);
    assert.equal(result.selection.selected[0]?.patientId, "ready");
    assert.equal(store.getLead("ready")?.reactivation_status, "locked");
    store.recordReactivationResult("ready", {
      batchId: result.batchId!,
      kind: "first",
      status: "sent",
      msisdn: "447700900003",
      message: result.selection.selected[0]?.message,
    });
    assert.ok(store.getLead("ready")?.reactivation_first_sent_at);
    process.env.REACTIVATION_ENABLED = "false";
  });

  it("holds the follow-up for seven days, then skips a reply", () => {
    const row = store.getLead("ready")!;
    assert.ok(row.reactivation_first_sent_at);
    const tooSoon = selectReactivation(store, "followup", 10);
    assert.equal(
      tooSoon.skipped.find((s) => s.patientId === "ready")?.reason,
      "follow-up not due yet",
    );

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    store.db
      .prepare(`UPDATE leads SET reactivation_first_sent_at = ? WHERE patient_id = ?`)
      .run(eightDaysAgo, "ready");

    const due = selectReactivation(store, "followup", 10);
    assert.equal(due.selected[0]?.patientId, "ready");
    assert.equal(due.selected[0]?.kind, "followup");

    store.db
      .prepare(`UPDATE leads SET ai_response_at = ? WHERE patient_id = ?`)
      .run(new Date().toISOString(), "ready");
    const replied = selectReactivation(store, "followup", 10);
    assert.equal(
      replied.skipped.find((s) => s.patientId === "ready")?.reason,
      "patient already replied",
    );
  });

  it("imports a Losses row without touching an existing live lead", () => {
    store.upsertScrapedLead(
      lead({
        patientId: "already-working",
        stage: "working",
        phone: "+447700900099",
        enquiredAt: "2026-01-01T10:00:00.000Z",
      }),
    );
    const result = importReactivationPeople(store, [
      {
        patientId: "import-new",
        name: "Samaira Aslam",
        phone: "+447950202525",
        enquiredAt: "2025-09-26T03:13:05.000+00:00",
      },
      {
        patientId: "already-working",
        name: "Should Not Overwrite",
        phone: "+447700900098",
        enquiredAt: "2025-09-26T03:13:05.000+00:00",
      },
      { name: "no id" },
    ]);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 2);
    const created = store.getLead("import-new");
    assert.equal(created?.stage, "maybeFuture");
    assert.equal(created?.treatment_type, "Implant");
    assert.equal(created?.first_name, "Samaira");
    assert.ok(created?.enquired_at);
    assert.equal(store.getLead("already-working")?.stage, "working");
    assert.equal(store.getLead("already-working")?.full_name, "Sam already-working");
  });

  it("imports the reason onto a known lead", () => {
    const { updated, unmatched } = importDiscardReasons(store, [
      { patientId: "no-reason", reason: REASON },
      { patientId: "missing", reason: REASON },
    ]);
    assert.equal(updated, 1);
    assert.equal(unmatched, 1);
    assert.equal(store.getLead("no-reason")?.discard_reason, REASON);
  });
});
