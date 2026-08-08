import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { isTestName } from "../leadflo/testName.js";
import type { NormalizedLead } from "../leadflo/types.js";

export type LeadStatus =
  | "discovered"
  | "webhook_pending"
  | "webhook_sent"
  | "webhook_failed"
  | "ai_received"
  | "note_written"
  | "note_skipped"
  | "note_failed";

export interface TrackedLeadRow {
  patient_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  email: string;
  treatment_type: string;
  source: string;
  stage: string;
  due_date: string | null;
  labels_json: string;
  is_test_name: number;
  status: LeadStatus;
  first_seen_at: string;
  last_seen_at: string;
  webhook_sent_at: string | null;
  ai_response_at: string | null;
  note_written_at: string | null;
  last_error: string | null;
  ai_note: string | null;
  payload_json: string;
  stage_checked_at: string | null;
  detail_fetched_at: string | null;
  outbound_status: OutboundStatus | null;
  outbound_batch_id: string | null;
  outbound_locked_at: string | null;
  outbound_sent_at: string | null;
  outbound_message: string | null;
  outbound_error: string | null;
  outbound_attempts: number;
}

/**
 * Outbound state is tracked separately from `status`, which only ever meant
 * "did we hand this lead to a webhook". A lead can be webhook_sent and still
 * never have been messaged.
 */
export type OutboundStatus = "locked" | "sent" | "failed" | "opted_out";

export interface OutboundDispatchRow {
  id: number;
  batch_id: string;
  patient_id: string;
  msisdn: string;
  status: string;
  message: string | null;
  provider_message_id: string | null;
  error: string | null;
  claimed_at: string;
  completed_at: string | null;
}

export interface StageChangeRow {
  id: number;
  patient_id: string;
  from_stage: string | null;
  to_stage: string;
  changed_at: string;
  detected_by: string;
}

export interface EventRow {
  id: number;
  created_at: string;
  kind: string;
  patient_id: string | null;
  message: string;
  meta_json: string | null;
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath = config.databasePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        webhook_sent_at TEXT,
        ai_response_at TEXT,
        note_written_at TEXT,
        last_error TEXT,
        ai_note TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        patient_id TEXT,
        message TEXT NOT NULL,
        meta_json TEXT
      );

      CREATE TABLE IF NOT EXISTS poll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        discovered INTEGER NOT NULL DEFAULT 0,
        new_leads INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lead_notes (
        note_id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        note_datetime TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lead_notes_patient
        ON lead_notes(patient_id);

      CREATE TABLE IF NOT EXISTS lead_stage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id TEXT NOT NULL,
        from_stage TEXT,
        to_stage TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        detected_by TEXT NOT NULL DEFAULT 'scrape'
      );

      CREATE INDEX IF NOT EXISTS idx_lead_stage_history_patient
        ON lead_stage_history(patient_id);

      CREATE TABLE IF NOT EXISTS outbound_dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        msisdn TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        message TEXT,
        provider_message_id TEXT,
        error TEXT,
        claimed_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_batch
        ON outbound_dispatches(batch_id);
      CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_patient
        ON outbound_dispatches(patient_id);
    `);

    this.addColumnIfMissing("leads", "stage_checked_at", "TEXT");
    this.addColumnIfMissing("leads", "detail_fetched_at", "TEXT");
    this.addColumnIfMissing("leads", "outbound_status", "TEXT");
    this.addColumnIfMissing("leads", "outbound_batch_id", "TEXT");
    this.addColumnIfMissing("leads", "outbound_locked_at", "TEXT");
    this.addColumnIfMissing("leads", "outbound_sent_at", "TEXT");
    this.addColumnIfMissing("leads", "outbound_message", "TEXT");
    this.addColumnIfMissing("leads", "outbound_error", "TEXT");
    this.addColumnIfMissing("leads", "outbound_attempts", "INTEGER NOT NULL DEFAULT 0");
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  logEvent(
    kind: string,
    message: string,
    patientId?: string | null,
    meta?: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (created_at, kind, patient_id, message, meta_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        kind,
        patientId ?? null,
        message,
        meta === undefined ? null : JSON.stringify(meta),
      );
  }

  getLead(patientId: string): TrackedLeadRow | undefined {
    return this.db
      .prepare(`SELECT * FROM leads WHERE patient_id = ?`)
      .get(patientId) as TrackedLeadRow | undefined;
  }

  /**
   * Ordered on the raw ISO timestamp rather than datetime(), which truncates to
   * whole seconds. A bulk backfill lands hundreds of rows inside one second, so
   * truncating leaves the order among them arbitrary and unstable between
   * calls. patient_id breaks any remaining tie.
   */
  listLeads(limit = 200): TrackedLeadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM leads ORDER BY first_seen_at DESC, patient_id ASC LIMIT ?`,
      )
      .all(limit) as TrackedLeadRow[];
  }

  /**
   * Every lead, for eligibility scanning. Outbound selection must see the whole
   * table: capping the scan means leads outside the window can never be
   * contacted, and with an unstable sort order it is not even the same leads
   * each time.
   */
  listAllLeads(): TrackedLeadRow[] {
    return this.db
      .prepare(`SELECT * FROM leads ORDER BY first_seen_at DESC, patient_id ASC`)
      .all() as TrackedLeadRow[];
  }

  listEvents(limit = 100): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit) as EventRow[];
  }

  listEventsForLead(patientId: string, limit = 100): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE patient_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(patientId, limit) as EventRow[];
  }

  /**
   * Upsert a scrape snapshot. Returns true if this patient is brand new.
   * Action-only scrapes carry fewer fields than patient detail fetches, so
   * empty incoming values must never overwrite what we already know.
   */
  upsertScrapedLead(
    lead: NormalizedLead,
    opts: { detailFetched?: boolean } = {},
  ): { isNew: boolean; row: TrackedLeadRow } {
    const existing = this.getLead(lead.patientId);
    const now = lead.scrapedAt;
    const detailAt = opts.detailFetched ? now : null;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO leads (
            patient_id, first_name, last_name, full_name, phone, email,
            treatment_type, source, stage, due_date, labels_json, is_test_name,
            status, first_seen_at, last_seen_at, payload_json,
            stage_checked_at, detail_fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?)`,
        )
        .run(
          lead.patientId,
          lead.firstName,
          lead.lastName,
          lead.fullName,
          lead.phone,
          lead.email,
          lead.treatmentType,
          lead.source,
          lead.stage,
          lead.dueDate,
          JSON.stringify(lead.labels),
          lead.isTestName ? 1 : 0,
          now,
          now,
          JSON.stringify(lead.raw ?? lead),
          now,
          detailAt,
        );
      this.recordStageChange(lead.patientId, null, lead.stage, "scrape", now);
      this.logEvent(
        "lead.discovered",
        `New ${lead.treatmentType || "unknown"} lead: ${lead.fullName}`,
        lead.patientId,
      );
      return { isNew: true, row: this.getLead(lead.patientId)! };
    }

    const keep = (incoming: string, current: string) => incoming || current;
    const merged = {
      firstName: keep(lead.firstName, existing.first_name),
      lastName: keep(lead.lastName, existing.last_name),
      fullName: keep(lead.fullName, existing.full_name),
      phone: keep(lead.phone, existing.phone),
      email: keep(lead.email, existing.email),
      treatmentType: keep(lead.treatmentType, existing.treatment_type),
      source: keep(lead.source, existing.source),
      stage: keep(lead.stage, existing.stage),
      labelsJson: lead.labels.length
        ? JSON.stringify(lead.labels)
        : existing.labels_json,
      payloadJson: opts.detailFetched
        ? JSON.stringify(lead.raw ?? lead)
        : existing.payload_json,
    };

    if (merged.stage !== existing.stage) {
      this.recordStageChange(
        lead.patientId,
        existing.stage,
        merged.stage,
        "scrape",
        now,
      );
    }

    this.db
      .prepare(
        `UPDATE leads SET
          first_name = ?, last_name = ?, full_name = ?, phone = ?, email = ?,
          treatment_type = ?, source = ?, stage = ?, due_date = ?, labels_json = ?,
          is_test_name = ?, last_seen_at = ?, payload_json = ?,
          stage_checked_at = ?,
          detail_fetched_at = COALESCE(?, detail_fetched_at)
         WHERE patient_id = ?`,
      )
      .run(
        merged.firstName,
        merged.lastName,
        merged.fullName,
        merged.phone,
        merged.email,
        merged.treatmentType,
        merged.source,
        merged.stage,
        lead.dueDate,
        merged.labelsJson,
        isTestName(merged.fullName) ? 1 : 0,
        now,
        merged.payloadJson,
        now,
        detailAt,
        lead.patientId,
      );
    return { isNew: false, row: this.getLead(lead.patientId)! };
  }

  recordStageChange(
    patientId: string,
    fromStage: string | null,
    toStage: string,
    detectedBy: string,
    changedAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO lead_stage_history
           (patient_id, from_stage, to_stage, changed_at, detected_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(patientId, fromStage, toStage, changedAt, detectedBy);
  }

  listStageHistory(patientId: string, limit = 50): StageChangeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM lead_stage_history
         WHERE patient_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(patientId, limit) as StageChangeRow[];
  }

  /**
   * Leads whose stage has not been verified recently. Leads drop out of the
   * due-actions feed once they progress, so without this their stage would
   * stay frozen at whatever we last saw.
   */
  listLeadsNeedingRefresh(staleBeforeIso: string, limit: number): TrackedLeadRow[] {
    // ISO-8601 strings compare correctly lexicographically and, unlike
    // SQLite's datetime(), keep millisecond precision.
    return this.db
      .prepare(
        `SELECT * FROM leads
         WHERE stage_checked_at IS NULL OR stage_checked_at < ?
         ORDER BY COALESCE(stage_checked_at, first_seen_at) ASC
         LIMIT ?`,
      )
      .all(staleBeforeIso, limit) as TrackedLeadRow[];
  }

  /** Move a lead to the back of the refresh queue without claiming success. */
  touchStageChecked(patientId: string, checkedAt = new Date().toISOString()): void {
    this.db
      .prepare(`UPDATE leads SET stage_checked_at = ? WHERE patient_id = ?`)
      .run(checkedAt, patientId);
  }

  /**
   * Apply a patient-detail refresh, recording any stage transition.
   *
   * Treatment type is refreshed alongside the stage because it decides who may
   * be messaged. A lead reclassified in Leadflo after discovery only ever
   * returns through this path, so ignoring it here would pin the lead to a
   * stale type indefinitely.
   */
  markLeadRefreshed(
    patientId: string,
    patient: { stage?: string | null; treatmentType?: string | null },
    checkedAt = new Date().toISOString(),
  ): {
    changed: boolean;
    fromStage: string | null;
    toStage: string | null;
    treatmentChanged: boolean;
    fromTreatment: string | null;
    toTreatment: string | null;
  } {
    const existing = this.getLead(patientId);
    if (!existing) {
      return {
        changed: false,
        fromStage: null,
        toStage: null,
        treatmentChanged: false,
        fromTreatment: null,
        toTreatment: null,
      };
    }

    const nextStage = patient.stage?.trim() || existing.stage;
    const changed = nextStage !== existing.stage;
    if (changed) {
      this.recordStageChange(patientId, existing.stage, nextStage, "refresh", checkedAt);
    }

    const nextTreatment = patient.treatmentType?.trim() || existing.treatment_type;
    const treatmentChanged = nextTreatment !== existing.treatment_type;

    this.db
      .prepare(
        `UPDATE leads SET stage = ?, treatment_type = ?, stage_checked_at = ?,
           detail_fetched_at = ?
         WHERE patient_id = ?`,
      )
      .run(nextStage, nextTreatment, checkedAt, checkedAt, patientId);

    return {
      changed,
      fromStage: existing.stage,
      toStage: nextStage,
      treatmentChanged,
      fromTreatment: existing.treatment_type,
      toTreatment: nextTreatment,
    };
  }

  /** Reserve leads for one WF-1 run so a concurrent run cannot pick them up. */
  lockOutboundBatch(patientIds: string[], batchId: string): void {
    if (!patientIds.length) return;
    const now = new Date().toISOString();
    const lockLead = this.db.prepare(
      `UPDATE leads SET outbound_status = 'locked', outbound_batch_id = ?,
         outbound_locked_at = ?, outbound_error = NULL
       WHERE patient_id = ?`,
    );
    const logDispatch = this.db.prepare(
      `INSERT INTO outbound_dispatches
         (batch_id, patient_id, msisdn, status, claimed_at)
       VALUES (?, ?, '', 'locked', ?)`,
    );
    this.db.transaction(() => {
      for (const patientId of patientIds) {
        lockLead.run(batchId, now, patientId);
        logDispatch.run(batchId, patientId, now);
      }
    })();
  }

  /**
   * Record what WF-1 actually did with one lead. A send that the provider
   * accepted but did not deliver must land here as a failure, otherwise the
   * lead is burned without ever having been messaged.
   */
  recordOutboundResult(
    patientId: string,
    result: {
      batchId: string;
      status: Extract<OutboundStatus, "sent" | "failed">;
      msisdn?: string;
      message?: string | null;
      providerMessageId?: string | null;
      error?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE leads SET
             outbound_status = ?,
             outbound_batch_id = ?,
             outbound_locked_at = NULL,
             outbound_sent_at = CASE WHEN ? = 'sent' THEN ? ELSE outbound_sent_at END,
             outbound_message = COALESCE(?, outbound_message),
             outbound_error = ?,
             outbound_attempts = outbound_attempts + 1
           WHERE patient_id = ?`,
        )
        .run(
          result.status,
          result.batchId,
          result.status,
          now,
          result.message ?? null,
          result.error ?? null,
          patientId,
        );
      this.db
        .prepare(
          `UPDATE outbound_dispatches SET
             status = ?, msisdn = ?, message = ?, provider_message_id = ?,
             error = ?, completed_at = ?
           WHERE batch_id = ? AND patient_id = ? AND completed_at IS NULL`,
        )
        .run(
          result.status,
          result.msisdn ?? "",
          result.message ?? null,
          result.providerMessageId ?? null,
          result.error ?? null,
          now,
          result.batchId,
          patientId,
        );
    })();
  }

  /** Put a claimed batch back in the pool when WF-1 rejects or abandons it. */
  releaseOutboundBatch(batchId: string): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE leads SET outbound_status = NULL, outbound_batch_id = NULL,
           outbound_locked_at = NULL
         WHERE outbound_batch_id = ? AND outbound_status = 'locked'`,
      )
      .run(batchId);
    this.db
      .prepare(
        `UPDATE outbound_dispatches SET status = 'released', completed_at = ?
         WHERE batch_id = ? AND completed_at IS NULL`,
      )
      .run(now, batchId);
    return info.changes;
  }

  /** A crashed run must not strand its leads as permanently unsendable. */
  releaseExpiredOutboundLocks(expiredBeforeIso: string): number {
    const stale = this.db
      .prepare(
        `SELECT DISTINCT outbound_batch_id AS batch_id FROM leads
         WHERE outbound_status = 'locked' AND outbound_locked_at < ?`,
      )
      .all(expiredBeforeIso) as Array<{ batch_id: string | null }>;

    let released = 0;
    for (const { batch_id } of stale) {
      if (!batch_id) continue;
      released += this.releaseOutboundBatch(batch_id);
      this.logEvent("outbound.lock_expired", `Released stale batch ${batch_id}`);
    }
    return released;
  }

  countOutboundSentSince(sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads
           WHERE outbound_status = 'sent' AND outbound_sent_at >= ?`,
        )
        .get(sinceIso) as { c: number }
    ).c;
  }

  listOutboundDispatches(limit = 100): OutboundDispatchRow[] {
    return this.db
      .prepare(`SELECT * FROM outbound_dispatches ORDER BY id DESC LIMIT ?`)
      .all(limit) as OutboundDispatchRow[];
  }

  getOutboundBatch(batchId: string): OutboundDispatchRow[] {
    return this.db
      .prepare(`SELECT * FROM outbound_dispatches WHERE batch_id = ? ORDER BY id ASC`)
      .all(batchId) as OutboundDispatchRow[];
  }

  setStatus(
    patientId: string,
    status: LeadStatus,
    patch: Partial<{
      webhook_sent_at: string | null;
      ai_response_at: string | null;
      note_written_at: string | null;
      last_error: string | null;
      ai_note: string | null;
    }> = {},
  ): void {
    const row = this.getLead(patientId);
    if (!row) throw new Error(`Unknown lead ${patientId}`);
    this.db
      .prepare(
        `UPDATE leads SET
          status = ?,
          webhook_sent_at = COALESCE(?, webhook_sent_at),
          ai_response_at = COALESCE(?, ai_response_at),
          note_written_at = COALESCE(?, note_written_at),
          last_error = ?,
          ai_note = COALESCE(?, ai_note)
         WHERE patient_id = ?`,
      )
      .run(
        status,
        patch.webhook_sent_at ?? null,
        patch.ai_response_at ?? null,
        patch.note_written_at ?? null,
        patch.last_error === undefined ? row.last_error : patch.last_error,
        patch.ai_note ?? null,
        patientId,
      );
  }

  startPollRun(): number {
    const info = this.db
      .prepare(`INSERT INTO poll_runs (started_at, ok) VALUES (?, 0)`)
      .run(new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  finishPollRun(
    id: number,
    result: { ok: boolean; discovered: number; newLeads: number; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE poll_runs SET finished_at = ?, ok = ?, discovered = ?, new_leads = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        result.ok ? 1 : 0,
        result.discovered,
        result.newLeads,
        result.error ?? null,
        id,
      );
  }

  latestPollRun():
    | {
        id: number;
        started_at: string;
        finished_at: string | null;
        ok: number;
        discovered: number;
        new_leads: number;
        error: string | null;
      }
    | undefined {
    return this.db
      .prepare(`SELECT * FROM poll_runs ORDER BY id DESC LIMIT 1`)
      .get() as
      | {
          id: number;
          started_at: string;
          finished_at: string | null;
          ok: number;
          discovered: number;
          new_leads: number;
          error: string | null;
        }
      | undefined;
  }

  stats(): {
    total: number;
    webhookSent: number;
    notesWritten: number;
    testLeads: number;
    errors: number;
  } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM leads`).get() as { c: number }
    ).c;
    const webhookSent = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE webhook_sent_at IS NOT NULL`)
        .get() as { c: number }
    ).c;
    const notesWritten = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE note_written_at IS NOT NULL`)
        .get() as { c: number }
    ).c;
    const testLeads = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE is_test_name = 1`)
        .get() as { c: number }
    ).c;
    const errors = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads WHERE status IN ('webhook_failed','note_failed')`,
        )
        .get() as { c: number }
    ).c;
    return { total, webhookSent, notesWritten, testLeads, errors };
  }

  /** Upsert Leadflo notes; returns each note with isNew relative to prior store state. */
  syncLeadNotes(
    patientId: string,
    notes: Array<{ id: string; title?: string; content: string; datetime: string }>,
  ): Array<{
    id: string;
    title: string;
    content: string;
    datetime: string;
    isNew: boolean;
    firstSeenAt: string;
  }> {
    const now = new Date().toISOString();
    const existing = new Set(
      (
        this.db
          .prepare(`SELECT note_id FROM lead_notes WHERE patient_id = ?`)
          .all(patientId) as Array<{ note_id: string }>
      ).map((r) => r.note_id),
    );

    const insert = this.db.prepare(
      `INSERT INTO lead_notes (note_id, patient_id, title, content, note_datetime, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE lead_notes SET title = ?, content = ?, note_datetime = ?, last_seen_at = ?
       WHERE note_id = ?`,
    );

    const out: Array<{
      id: string;
      title: string;
      content: string;
      datetime: string;
      isNew: boolean;
      firstSeenAt: string;
    }> = [];

    const sync = this.db.transaction(() => {
      for (const note of notes) {
        const title = note.title ?? "";
        const isNew = !existing.has(note.id);
        if (isNew) {
          insert.run(note.id, patientId, title, note.content, note.datetime, now, now);
          out.push({
            id: note.id,
            title,
            content: note.content,
            datetime: note.datetime,
            isNew: true,
            firstSeenAt: now,
          });
        } else {
          update.run(title, note.content, note.datetime, now, note.id);
          const row = this.db
            .prepare(`SELECT first_seen_at FROM lead_notes WHERE note_id = ?`)
            .get(note.id) as { first_seen_at: string };
          out.push({
            id: note.id,
            title,
            content: note.content,
            datetime: note.datetime,
            isNew: false,
            firstSeenAt: row.first_seen_at,
          });
        }
      }
    });
    sync();

    return out.sort((a, b) => b.datetime.localeCompare(a.datetime));
  }

  analytics(
    days = 30,
    trackedTypes: string[] = ["implant"],
  ): {
    days: number;
    leadsPerDay: Array<{ date: string; count: number; tracked: number }>;
    byType: Array<{ type: string; count: number; tracked: boolean }>;
    byStage: Array<{ stage: string; count: number }>;
    bySource: Array<{ source: string; count: number }>;
    totals: {
      discovered: number;
      tracked: number;
      notesWritten: number;
      medianTimeToNoteMs: number | null;
    };
  } {
    const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
    const tracked = trackedTypes.map((t) => t.toLowerCase());
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (safeDays - 1));
    const startIso = start.toISOString();

    const dayRows = this.db
      .prepare(
        `SELECT substr(first_seen_at, 1, 10) AS day,
                COUNT(*) AS c,
                SUM(CASE WHEN lower(treatment_type) IN (${tracked.map(() => "?").join(",") || "''"}) THEN 1 ELSE 0 END) AS tracked
         FROM leads
         WHERE datetime(first_seen_at) >= datetime(?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(...tracked, startIso) as Array<{ day: string; c: number; tracked: number }>;

    const counts = new Map(dayRows.map((r) => [r.day, r]));
    const leadsPerDay: Array<{ date: string; count: number; tracked: number }> = [];
    for (let i = 0; i < safeDays; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      const row = counts.get(key);
      leadsPerDay.push({
        date: key,
        count: row?.c ?? 0,
        tracked: row?.tracked ?? 0,
      });
    }

    const byType = (
      this.db
        .prepare(
          `SELECT COALESCE(NULLIF(trim(treatment_type), ''), 'Unknown') AS type, COUNT(*) AS c
           FROM leads GROUP BY type ORDER BY c DESC, type ASC`,
        )
        .all() as Array<{ type: string; c: number }>
    ).map((r) => ({
      type: r.type,
      count: r.c,
      tracked: tracked.some(
        (t) => r.type.toLowerCase() === t || r.type.toLowerCase().includes(t),
      ),
    }));

    const byStage = (
      this.db
        .prepare(
          `SELECT COALESCE(NULLIF(trim(stage), ''), 'unknown') AS stage, COUNT(*) AS c
           FROM leads GROUP BY stage ORDER BY c DESC, stage ASC`,
        )
        .all() as Array<{ stage: string; c: number }>
    ).map((r) => ({ stage: r.stage, count: r.c }));

    const bySource = (
      this.db
        .prepare(
          `SELECT COALESCE(NULLIF(trim(source), ''), 'Unknown') AS source, COUNT(*) AS c
           FROM leads GROUP BY source ORDER BY c DESC, source ASC`,
        )
        .all() as Array<{ source: string; c: number }>
    ).map((r) => ({ source: r.source, count: r.c }));

    const discovered = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM leads`).get() as { c: number }
    ).c;
    const trackedCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM leads WHERE lower(treatment_type) IN (${tracked.map(() => "?").join(",") || "''"})`,
        )
        .get(...tracked) as { c: number }
    ).c;
    const notesWritten = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM leads WHERE note_written_at IS NOT NULL`)
        .get() as { c: number }
    ).c;

    const durations = (
      this.db
        .prepare(
          `SELECT (julianday(note_written_at) - julianday(first_seen_at)) * 86400000 AS ms
           FROM leads
           WHERE note_written_at IS NOT NULL AND first_seen_at IS NOT NULL`,
        )
        .all() as Array<{ ms: number }>
    )
      .map((r) => r.ms)
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b);

    let medianTimeToNoteMs: number | null = null;
    if (durations.length) {
      const mid = Math.floor(durations.length / 2);
      medianTimeToNoteMs =
        durations.length % 2 === 0
          ? Math.round((durations[mid - 1]! + durations[mid]!) / 2)
          : Math.round(durations[mid]!);
    }

    return {
      days: safeDays,
      leadsPerDay,
      byType,
      byStage,
      bySource,
      totals: { discovered, tracked: trackedCount, notesWritten, medianTimeToNoteMs },
    };
  }

  close(): void {
    this.db.close();
  }
}
