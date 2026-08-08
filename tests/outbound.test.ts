import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { NormalizedLead } from "../src/leadflo/types.js";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.OUTBOUND_ENABLED = "true";
process.env.OUTBOUND_ALLOWLIST_ONLY = "false";
process.env.OUTBOUND_MAX_PER_RUN = "2";
process.env.OUTBOUND_MAX_PER_DAY = "3";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-outbound-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const { claimBatch, normalizePhone, selectCandidates, sessionKeyFor } = await import(
  "../src/services/outbound.js"
);

function lead(overrides: Partial<NormalizedLead> & { patientId: string }): NormalizedLead {
  return {
    firstName: "Lead",
    lastName: overrides.patientId,
    fullName: `Lead ${overrides.patientId}`,
    phone: "+447700900000",
    email: `${overrides.patientId}@example.com`,
    treatmentType: "Implant",
    source: "Google Ads",
    stage: "newLead",
    dueDate: null,
    labels: [],
    isTestName: false,
    scrapedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("phone normalisation", () => {
  it("accepts the formats Leadflo actually stores", () => {
    assert.equal(normalizePhone("+447700900123").msisdn, "447700900123");
    assert.equal(normalizePhone("07700 900123").msisdn, "447700900123");
    assert.equal(normalizePhone("0044 7700 900123").msisdn, "447700900123");
    assert.equal(normalizePhone("447700900123").msisdn, "447700900123");
  });

  it("refuses anything it cannot resolve to a UK mobile", () => {
    assert.equal(normalizePhone("").ok, false);
    assert.equal(normalizePhone("+2347012345678").ok, false, "non-UK");
    assert.equal(normalizePhone("+441614643072").ok, false, "landline");
    assert.equal(normalizePhone("12345").ok, false, "too short");
    // A bare national number without a leading 0 is not safely resolvable.
    assert.equal(normalizePhone("7700900123").ok, false);
  });
});

describe("outbound candidate selection", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;

  before(() => {
    store = new Store(dbPath);
    store.upsertScrapedLead(lead({ patientId: "p1", phone: "+447700900001" }));
    store.upsertScrapedLead(lead({ patientId: "p2", phone: "+447700900002" }));
    store.upsertScrapedLead(lead({ patientId: "p3", phone: "+447700900003" }));
    store.upsertScrapedLead(
      lead({ patientId: "general", treatmentType: "General", phone: "+447700900004" }),
    );
    store.upsertScrapedLead(
      lead({ patientId: "late", stage: "consultation", phone: "+447700900005" }),
    );
    store.upsertScrapedLead(lead({ patientId: "nophone", phone: "" }));
    store.upsertScrapedLead(
      lead({ patientId: "foreign", phone: "+2347012345678" }),
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

  it("excludes untracked treatments, late stages, and unusable numbers", () => {
    const { skipped } = selectCandidates(store, 10);
    const reasonFor = (id: string) =>
      skipped.find((s) => s.patientId === id)?.reason ?? "";

    assert.match(reasonFor("general"), /not tracked/);
    assert.match(reasonFor("late"), /past the contact stages/);
    assert.match(reasonFor("nophone"), /no phone number/);
    assert.match(reasonFor("foreign"), /not a UK mobile/);
  });

  it("caps the batch and reports who was held back", () => {
    const selection = selectCandidates(store, 10);
    assert.equal(selection.selected.length, 2, "OUTBOUND_MAX_PER_RUN=2");
    assert.ok(
      selection.skipped.some((s) => s.reason === "eligible, held back by run cap"),
    );
  });

  it("seeds the session key WF-2 reads so the reply continues the thread", () => {
    const [first] = selectCandidates(store, 1).selected;
    assert.equal(first?.sessionKey, sessionKeyFor(first!.msisdn));
    // Must match WF-2's Postgres Chat Memory key exactly.
    assert.equal(first?.sessionKey, `da_${first?.msisdn}`);
  });

  it("locks a claimed batch so a second run cannot pick up the same leads", () => {
    const first = claimBatch(store, 2);
    assert.equal(first.ok, true);
    assert.equal(first.selection.selected.length, 2);

    const second = claimBatch(store, 2);
    const claimedIds = first.selection.selected.map((c) => c.patientId);
    for (const id of claimedIds) {
      assert.ok(
        !second.selection.selected.some((c) => c.patientId === id),
        `${id} must not be handed out twice`,
      );
    }

    store.releaseOutboundBatch(first.batchId!);
    assert.equal(store.getLead(claimedIds[0]!)?.outbound_status, null);
  });

  it("does not re-contact a lead that was already sent", () => {
    const claim = claimBatch(store, 1);
    const target = claim.selection.selected[0]!;
    store.recordOutboundResult(target.patientId, {
      batchId: claim.batchId!,
      status: "sent",
      msisdn: target.msisdn,
      message: "Hi, it's Poppy…",
      providerMessageId: "wamid.test",
    });

    const row = store.getLead(target.patientId)!;
    assert.equal(row.outbound_status, "sent");
    assert.ok(row.outbound_sent_at);
    assert.equal(row.outbound_attempts, 1);

    const next = selectCandidates(store, 10);
    assert.ok(!next.selected.some((c) => c.patientId === target.patientId));
    assert.equal(
      next.skipped.find((s) => s.patientId === target.patientId)?.reason,
      "already contacted",
    );
    assert.equal(next.caps.sentToday, 1);
  });

  it("frees leads whose run crashed without reporting back", () => {
    const claim = claimBatch(store, 1);
    const target = claim.selection.selected[0]!;
    assert.equal(store.getLead(target.patientId)?.outbound_status, "locked");

    // Anything locked before "now" is stale.
    store.releaseExpiredOutboundLocks(new Date(Date.now() + 1000).toISOString());
    assert.equal(store.getLead(target.patientId)?.outbound_status, null);
  });
});

describe("outbound kill switch", () => {
  const dbPath = path.join(os.tmpdir(), `leadflo-outbound-off-${Date.now()}.db`);
  let store: InstanceType<typeof Store>;

  before(() => {
    store = new Store(dbPath);
    store.upsertScrapedLead(lead({ patientId: "off1", phone: "+447700900009" }));
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("refuses to hand out a batch when the allowlist excludes everyone", async () => {
    const { config } = await import("../src/config.js");
    config.outbound.allowlistOnly = true;
    config.outbound.allowlist = ["447700900999"];

    const result = claimBatch(store, 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no eligible candidates");
    assert.match(
      result.selection.skipped[0]?.reason ?? "",
      /not on the outbound allowlist/,
    );

    config.outbound.allowlistOnly = false;
    config.outbound.allowlist = [];
  });

  it("previews but never claims while OUTBOUND_ENABLED is false", async () => {
    const { config } = await import("../src/config.js");
    config.outbound.enabled = false;

    const preview = selectCandidates(store, 1);
    assert.equal(preview.selected.length, 1, "preview still shows who would be sent");

    const result = claimBatch(store, 1);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /OUTBOUND_ENABLED is false/);
    assert.equal(store.getLead("off1")?.outbound_status, null, "nothing locked");

    config.outbound.enabled = true;
  });
});
