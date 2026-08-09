import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { after, before, describe, it } from "node:test";

process.env.LEADFLO_MODE = "mock";
process.env.DATABASE_PATH = path.join(os.tmpdir(), `leadflo-recover-${Date.now()}.db`);

const { Store } = await import("../src/db/store.js");

const dbPath = process.env.DATABASE_PATH!;
const PATIENT = "6b1f2d90-77aa-4c31-9d55-0f1e2a3b4c5d";

let store: InstanceType<typeof Store>;

function raw(target: InstanceType<typeof Store>): BetterSqlite3.Database {
  return (target as unknown as { db: BetterSqlite3.Database }).db;
}

function cleanUp(): void {
  for (const file of fs.readdirSync(path.dirname(dbPath))) {
    if (file.startsWith(path.basename(dbPath))) {
      fs.rmSync(path.join(path.dirname(dbPath), file), { force: true });
    }
  }
}

/**
 * Overwrite pages in the middle of the file with rubbish. Truncating instead
 * would produce a short file, which SQLite treats as a different and more
 * recoverable problem than the page damage seen in production.
 */
function damageDatabaseFile(): void {
  const handle = fs.openSync(dbPath, "r+");
  const size = fs.fstatSync(handle).size;
  fs.writeSync(handle, Buffer.alloc(2048, 0x5a), 0, 2048, Math.floor(size / 2));
  fs.closeSync(handle);
}

before(() => {
  cleanUp();
  store = new Store();
});

after(() => {
  store?.close?.();
  cleanUp();
});

describe("a database SQLite reports as corrupt", () => {
  it("is rebuilt, keeping settings and the record of who was messaged", () => {
    const db = raw(store);
    const now = new Date().toISOString();

    store.setSetting("OUTBOUND_ALLOWLIST", "447700900123");
    db.prepare(
      `INSERT INTO outbound_dispatches
         (batch_id, patient_id, msisdn, status, message, claimed_at, completed_at)
       VALUES ('batch-1', ?, '447700900123', 'sent', 'Hello', ?, ?)`,
    ).run(PATIENT, now, now);
    db.prepare(
      `INSERT INTO leads (patient_id, full_name, first_seen_at, last_seen_at)
       VALUES (?, 'A Patient', ?, ?)`,
    ).run(PATIENT, now, now);
    store.close();

    damageDatabaseFile();
    const rebuilt = new Store();
    store = rebuilt;

    assert.equal(
      rebuilt.getSetting("OUTBOUND_ALLOWLIST"),
      "447700900123",
      "losing the allowlist on a rebuild would silently change who can be messaged",
    );
    assert.ok(
      rebuilt.listContactedPatientIds().has(PATIENT),
      "a rebuild must not turn an already-messaged patient back into a candidate",
    );
    assert.ok(
      fs.readdirSync(path.dirname(dbPath)).some((f) => f.includes(".corrupt-")),
      "the damaged file is kept for diagnosis rather than deleted",
    );
  });

  it("records the rebuild so it cannot happen unnoticed", () => {
    const kinds = store.listEvents(20).map((event) => event.kind);
    assert.ok(kinds.includes("db.rebuilt"), `expected a db.rebuilt event, saw ${kinds}`);
  });

  it("does not touch a healthy database", () => {
    store.close();
    const before = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes(".corrupt-"));
    store = new Store();
    const after = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes(".corrupt-"));
    assert.equal(after.length, before.length, "a healthy file must be left alone");
  });
});
