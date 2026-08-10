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
// Generous caps: these tests care about who is eligible, not about throttling,
// and a cap of one makes claims pick an arbitrary lead once two are in play.
process.env.OUTBOUND_MAX_PER_RUN = "5";
process.env.OUTBOUND_MAX_PER_DAY = "50";
process.env.WF1_API_KEY = "test-key";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-reset-${Date.now()}.db`);

const { Store } = await import("../src/db/store.js");
const { claimBatch, selectCandidates } = await import("../src/services/outbound.js");
const { createApp } = await import("../src/app.js");

const CONTACTED = "contacted-patient";
const OTHER = "other-patient";

let store: InstanceType<typeof Store>;
let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

function lead(patientId: string, phone: string): NormalizedLead {
  return {
    patientId,
    firstName: "Lead",
    lastName: patientId,
    fullName: `Lead ${patientId}`,
    phone,
    email: `${patientId}@example.com`,
    treatmentType: "Implant",
    source: "Google Ads",
    stage: "newLead",
    dueDate: null,
    labels: [],
    isTestName: false,
    scrapedAt: new Date().toISOString(),
  };
}

/** Take a lead all the way to a completed send, the state a reset has to undo. */
function messageThem(patientId: string): void {
  const claim = claimBatch(store, 5);
  const target = claim.selection.selected.find((c) => c.patientId === patientId);
  assert.ok(target, `expected ${patientId} to be claimable`);
  store.recordOutboundResult(patientId, {
    batchId: claim.batchId!,
    status: "sent",
    msisdn: target!.msisdn,
    message: "Hello",
    providerMessageId: "wamid.test",
  });
  // Hand back anyone else the claim happened to lock, so each test starts from
  // one contacted lead rather than a pile of leads stuck mid-batch.
  store.releaseOutboundBatch(claim.batchId!);
}

function eligible(): string[] {
  return selectCandidates(store, 10).selected.map((c) => c.patientId);
}

before(async () => {
  store = new Store();
  store.upsertScrapedLead(lead(CONTACTED, "+447700900101"));
  const app = createApp({
    store,
    poller: { tick: async () => ({}), applyIntervalChange: () => false } as never,
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

describe("resetting one lead's outbound state", () => {
  it("makes an already-contacted lead selectable again", () => {
    messageThem(CONTACTED);
    assert.equal(store.getLead(CONTACTED)?.outbound_status, "sent");
    assert.deepEqual(eligible(), [], "a sent lead is not a candidate");

    const result = store.resetOutbound(CONTACTED);
    assert.equal(result.lead, true);
    assert.equal(result.dispatches, 1);
    assert.deepEqual(eligible(), [CONTACTED], "and now they are back in the pool");
  });

  it("clears both records, because the selector reads both", () => {
    messageThem(CONTACTED);
    store.resetOutbound(CONTACTED);

    assert.equal(store.getLead(CONTACTED)?.outbound_status, null);
    assert.equal(store.getLead(CONTACTED)?.outbound_sent_at, null);
    assert.equal(
      store.listContactedPatientIds().has(CONTACTED),
      false,
      "the dispatch log is the fallback check, so it has to move too",
    );
  });

  it("keeps what was actually sent, rather than deleting the evidence", () => {
    const theirs = store
      .listOutboundDispatches(50)
      .filter((row) => row.patient_id === CONTACTED);
    assert.ok(theirs.length > 0, "the dispatch rows survive a reset");
    assert.ok(
      theirs.every((row) => row.status === "reset"),
      "marked, not removed",
    );
    assert.ok(
      theirs.some((row) => row.message === "Hello"),
      "including the message the patient received",
    );
  });

  it("touches nobody else", () => {
    store.upsertScrapedLead(lead(OTHER, "+447700900102"));
    messageThem(OTHER);
    messageThem(CONTACTED);

    store.resetOutbound(CONTACTED);

    assert.equal(
      store.getLead(OTHER)?.outbound_status,
      "sent",
      "resetting one lead must never re-open the rest of the table",
    );
    assert.equal(store.listContactedPatientIds().has(OTHER), true);
  });

  it("is harmless to repeat on a lead that was never contacted", () => {
    const result = store.resetOutbound(OTHER);
    store.resetOutbound(OTHER);
    assert.equal(result.dispatches, 1);
    assert.equal(store.resetOutbound(OTHER).dispatches, 0, "nothing left to clear");
  });
});

describe("the reset endpoint", () => {
  it("refuses without the WF-1 key, since it removes a safety rule", async () => {
    messageThem(CONTACTED);
    const response = await fetch(`${baseUrl}/api/leads/${CONTACTED}/outbound/reset`, {
      method: "POST",
    });
    assert.equal(response.status, 401);
    assert.equal(
      store.getLead(CONTACTED)?.outbound_status,
      "sent",
      "and the lead stays contacted",
    );
  });

  it("resets the named lead and reports what it undid", async () => {
    const response = await fetch(`${baseUrl}/api/leads/${CONTACTED}/outbound/reset`, {
      method: "POST",
      headers: { "x-wf1-key": "test-key" },
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      previousStatus: string;
      dispatchesReset: number;
      lead: { outboundStatus: string | null };
    };
    assert.equal(body.previousStatus, "sent");
    assert.equal(body.dispatchesReset, 1);
    assert.equal(body.lead.outboundStatus, null);
    assert.ok(eligible().includes(CONTACTED));
  });

  it("records the reset, so an unexpected second message is explainable", () => {
    const kinds = store.listEventsForLead(CONTACTED, 20).map((event) => event.kind);
    assert.ok(kinds.includes("outbound.reset"), `expected outbound.reset, saw ${kinds}`);
  });

  it("404s on a patient it does not know", async () => {
    const response = await fetch(`${baseUrl}/api/leads/nobody/outbound/reset`, {
      method: "POST",
      headers: { "x-wf1-key": "test-key" },
    });
    assert.equal(response.status, 404);
  });
});
