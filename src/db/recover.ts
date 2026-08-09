/**
 * Rebuilding the database when SQLite reports it as damaged.
 *
 * Almost everything this service stores is a copy of Leadflo, so a corrupt file
 * is cheaper to discard than to repair: the poller restores the leads within a
 * couple of minutes. The exceptions are the record of who has already been
 * messaged and the runtime settings, neither of which exists anywhere else, so
 * those are read out before the file is set aside and written back afterwards.
 *
 * The damaged file is renamed rather than deleted. Corruption is exactly the
 * situation where you want to be able to look at the evidence afterwards.
 */

import fs from "node:fs";
import Database from "better-sqlite3";

export interface SalvagedState {
  settings: Array<{ key: string; value: string }>;
  dispatches: Record<string, unknown>[];
  /** What SQLite objected to, for the log and the audit event. */
  problem: string;
}

/** Apply the pragmas every connection needs. Not WAL: see Store's constructor. */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = DELETE");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * SQLite's own verdict on the file, or null when it is healthy. The check reads
 * every page, which is why it runs at startup only and not per poll.
 */
export function integrityProblem(db: Database.Database): string | null {
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const first = rows[0]?.integrity_check ?? "unknown";
    return first === "ok" ? null : first;
  } catch (error) {
    // A file too damaged to answer the question is damaged.
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Read the state that cannot be rebuilt from Leadflo. Every read is optional:
 * the point of this function is that the database is already known to be
 * broken, so a table that will not read is a table we continue without.
 */
export function salvageState(db: Database.Database, problem: string): SalvagedState {
  const settings = readOrEmpty<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM settings`,
  );
  const dispatches = readOrEmpty<Record<string, unknown>>(
    db,
    `SELECT batch_id, patient_id, msisdn, status, message, provider_message_id,
            error, claimed_at, completed_at
       FROM outbound_dispatches`,
  );
  return { settings, dispatches, problem };
}

function readOrEmpty<T>(db: Database.Database, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch (error) {
    console.error(`[recover] could not salvage via "${sql.split("\n")[0]}":`, error);
    return [];
  }
}

/** Move the damaged file and its sidecars aside. Returns where it went. */
export function setDamagedFileAside(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kept = `${dbPath}.corrupt-${stamp}`;
  fs.renameSync(dbPath, kept);
  // Sidecars from the era when this ran in WAL mode. Leaving a stale -wal next
  // to a fresh database is its own way to lose data.
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
  }
  return kept;
}
