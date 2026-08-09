import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { after, before, describe, it } from "node:test";

process.env.LEADFLO_MODE = "mock";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-phantom-${Date.now()}.db`);

const Database = (await import("better-sqlite3")).default;
const { Store } = await import("../src/db/store.js");

const REAL = "3f2a1c88-1a2b-4c3d-9e0f-112233445566";
const dbPath = process.env.DATABASE_PATH!;

let store: InstanceType<typeof Store>;

/**
 * A leads table without the NOT NULL on the seen timestamps. The production
 * database accepted these rows, so it must lack the constraint too — trying to
 * insert one into a current schema fails, which is itself the point.
 */
function createLegacySchema(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      patient_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      treatment_type TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      is_test_name INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'discovered',
      first_seen_at TEXT,
      last_seen_at TEXT,
      webhook_sent_at TEXT,
      ai_response_at TEXT,
      note_written_at TEXT,
      last_error TEXT,
      ai_note TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.close();
}

/** The exact shape found in production: a table name and its row count. */
function insertDebris(db: BetterSqlite3.Database, name: string, rowCount: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO leads (patient_id, first_name, first_seen_at, last_seen_at)
     VALUES (?, ?, NULL, NULL)`,
  ).run(name, rowCount);
}

function raw(target: InstanceType<typeof Store>): BetterSqlite3.Database {
  return (target as unknown as { db: BetterSqlite3.Database }).db;
}

before(() => {
  createLegacySchema();
  store = new Store();
});

after(() => {
  store?.close?.();
  fs.rmSync(dbPath, { force: true });
});

describe("rows in the leads table that are not leads", () => {
  it("keeps them out of the queues that call Leadflo", () => {
    const db = raw(store);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO leads (patient_id, full_name, first_seen_at, last_seen_at)
       VALUES (?, 'A Patient', ?, ?)`,
    ).run(REAL, now, now);
    insertDebris(db, "events", 3931);
    insertDebris(db, "lead_stage_history", 572);
    insertDebris(db, "poll_runs", 118);

    const refresh = store.listLeadsNeedingRefresh(
      new Date(Date.now() + 1000).toISOString(),
      50,
    );
    assert.deepEqual(
      refresh.map((row) => row.patient_id),
      [REAL],
      "a lookup that can only ever fail must not be queued every minute",
    );

    assert.deepEqual(
      store.listLeadsMissingEnquiryDate(50).map((row) => row.patient_id),
      [REAL],
    );
  });

  it("removes them on the next start", () => {
    store.close?.();
    const reopened = new Store();
    const remaining = (
      raw(reopened).prepare(`SELECT patient_id FROM leads`).all() as Array<{
        patient_id: string;
      }>
    ).map((row) => row.patient_id);

    assert.deepEqual(remaining, [REAL], "only the real patient survives");
    store = reopened;
  });

  it("leaves a lead alone once it has been seen, whatever its id looks like", () => {
    const db = raw(store);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO leads (patient_id, full_name, first_seen_at, last_seen_at)
       VALUES ('legacy-id-42', 'Legacy Patient', ?, ?)`,
    ).run(now, now);

    const reopened = new Store();
    const remaining = (
      raw(reopened).prepare(`SELECT patient_id FROM leads ORDER BY patient_id`).all() as Array<{
        patient_id: string;
      }>
    ).map((row) => row.patient_id);

    assert.ok(
      remaining.includes("legacy-id-42"),
      "the purge must not depend on ids being UUIDs, or a format change deletes everyone",
    );
    store.close?.();
    store = reopened;
  });
});
