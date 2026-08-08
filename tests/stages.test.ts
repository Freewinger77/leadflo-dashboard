import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type {
  LeadfloAction,
  LeadfloClient,
  LeadfloPatient,
  LeadfloTimelineItem,
} from "../src/leadflo/types.js";

process.env.LEADFLO_MODE = "mock";
process.env.WEBHOOK_URL = "";
process.env.NOTES_ONLY_TEST_NAMES = "true";
// Refresh every tick so stage drift is observable without waiting.
process.env.STAGE_REFRESH_INTERVAL_MS = "0";
process.env.DATABASE_PATH = path.join(
  os.tmpdir(),
  `leadflo-stages-${Date.now()}.db`,
);

const { Store } = await import("../src/db/store.js");
const { Poller } = await import("../src/services/poller.js");
const { isTestName } = await import("../src/leadflo/testName.js");

function action(patientId: string, stage: string, type = "Implant"): LeadfloAction {
  return {
    patient_id: patientId,
    stage,
    first_name: "Lead",
    last_name: patientId,
    phone: "07700 900000",
    type,
  };
}

/** Mutable stand-in for Leadflo so stage progression can be simulated. */
class FakeClient implements LeadfloClient {
  actions: LeadfloAction[] = [];
  stages = new Map<string, string>();
  types = new Map<string, string>();
  patientCalls = 0;

  async login(): Promise<void> {}
  async ensureSession(): Promise<void> {}

  async getDueActions(stages: string[]): Promise<LeadfloAction[]> {
    return this.actions.filter((a) => stages.includes(a.stage));
  }

  async getPatient(patientId: string): Promise<LeadfloPatient> {
    this.patientCalls += 1;
    return {
      id: patientId,
      first_name: "Lead",
      last_name: patientId,
      email: `${patientId}@example.com`,
      phone: "07700 900000",
      type: this.types.get(patientId) ?? "Implant",
      source: "Practice Website",
      labels: [],
      stage: this.stages.get(patientId) ?? "newLead",
    };
  }

  async getTimeline(): Promise<LeadfloTimelineItem[]> {
    return [];
  }
  async addNote(): Promise<void> {}
  async ping(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

describe("stage tracking", () => {
  const dbPath = process.env.DATABASE_PATH!;
  let store: InstanceType<typeof Store>;
  let client: FakeClient;
  let poller: InstanceType<typeof Poller>;

  before(() => {
    store = new Store(dbPath);
    client = new FakeClient();
    poller = new Poller({ store, client, publicBaseUrl: "http://localhost:8788" });
  });

  after(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("fetches patient detail once per lead, not on every tick", async () => {
    client.actions = [action("p1", "newLead")];
    client.stages.set("p1", "newLead");

    await poller.tick();
    assert.equal(client.patientCalls, 1);

    await poller.tick();
    assert.equal(client.patientCalls, 1, "known lead should not be re-fetched");
  });

  it("records the initial stage in history", () => {
    const history = store.listStageHistory("p1");
    assert.equal(history.length, 1);
    assert.equal(history[0]?.from_stage, null);
    assert.equal(history[0]?.to_stage, "newLead");
  });

  it("detects stage progression after a lead leaves the due-actions feed", async () => {
    // The lead progresses, so Leadflo stops returning it as a due action.
    client.actions = [];
    client.stages.set("p1", "consultation");
    store.touchStageChecked("p1", new Date(Date.now() - 60_000).toISOString());

    const result = await poller.tick();
    assert.equal(result.refreshed, 1);

    assert.equal(store.getLead("p1")?.stage, "consultation");
    const history = store.listStageHistory("p1");
    assert.equal(history[0]?.from_stage, "newLead");
    assert.equal(history[0]?.to_stage, "consultation");
    assert.equal(history[0]?.detected_by, "refresh");
  });

  it("tracks later-stage leads without dispatching a webhook", async () => {
    client.actions = [action("p2", "consultation")];
    client.stages.set("p2", "consultation");

    await poller.tick();

    const lead = store.getLead("p2");
    assert.equal(lead?.stage, "consultation");
    assert.equal(
      lead?.status,
      "discovered",
      "leads discovered past the contact stages must not be dispatched",
    );
  });

  it("does not overwrite known contact details with an empty action scrape", async () => {
    const before = store.getLead("p1");
    assert.equal(before?.email, "p1@example.com");

    client.actions = [
      { patient_id: "p1", stage: "working", first_name: "", last_name: "", phone: "", type: "" },
    ];
    await poller.tick();

    const after = store.getLead("p1");
    assert.equal(after?.email, "p1@example.com");
    assert.equal(after?.treatment_type, "Implant");
  });

  it("picks up a treatment reclassified in Leadflo after discovery", async () => {
    client.actions = [action("p3", "newLead", "General")];
    client.stages.set("p3", "newLead");
    client.types.set("p3", "General");
    await poller.tick();
    assert.equal(store.getLead("p3")?.treatment_type, "General");

    // The lead leaves the due feed, so refresh is the only path back in.
    client.actions = [];
    client.types.set("p3", "Implant");
    // Age it past the staleness cutoff explicitly: back-to-back ticks can land
    // in the same millisecond, which would leave the refresh queue empty.
    client.stages.set("p3", "newLead");
    store.touchStageChecked("p3", new Date(Date.now() - 60_000).toISOString());
    await poller.tick();

    assert.equal(
      store.getLead("p3")?.treatment_type,
      "Implant",
      "treatment type gates who WF-1 may contact, so it must not go stale",
    );
  });

  it("treats test names as whole words only", () => {
    assert.equal(isTestName("asif test"), true);
    assert.equal(isTestName("Bob Test"), true);
    assert.equal(isTestName("Preston Miller"), false);
    assert.equal(isTestName("Testa Rossa"), false);
  });
});
