import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
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
    `);
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

  listLeads(limit = 200): TrackedLeadRow[] {
    return this.db
      .prepare(
        `SELECT * FROM leads ORDER BY datetime(first_seen_at) DESC LIMIT ?`,
      )
      .all(limit) as TrackedLeadRow[];
  }

  listEvents(limit = 100): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit) as EventRow[];
  }

  /** Upsert scrape snapshot. Returns true if this patient is brand new. */
  upsertScrapedLead(lead: NormalizedLead): { isNew: boolean; row: TrackedLeadRow } {
    const existing = this.getLead(lead.patientId);
    const now = lead.scrapedAt;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO leads (
            patient_id, first_name, last_name, full_name, phone, email,
            treatment_type, source, stage, due_date, labels_json, is_test_name,
            status, first_seen_at, last_seen_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`,
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
        );
      this.logEvent("lead.discovered", `New implant lead: ${lead.fullName}`, lead.patientId);
      return { isNew: true, row: this.getLead(lead.patientId)! };
    }

    this.db
      .prepare(
        `UPDATE leads SET
          first_name = ?, last_name = ?, full_name = ?, phone = ?, email = ?,
          treatment_type = ?, source = ?, stage = ?, due_date = ?, labels_json = ?,
          is_test_name = ?, last_seen_at = ?, payload_json = ?
         WHERE patient_id = ?`,
      )
      .run(
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
        JSON.stringify(lead.raw ?? lead),
        lead.patientId,
      );
    return { isNew: false, row: this.getLead(lead.patientId)! };
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

  analytics(days = 14): {
    leadsPerDay: Array<{ date: string; count: number }>;
    byType: Array<{ type: string; count: number }>;
    byStage: Array<{ stage: string; count: number }>;
    bySource: Array<{ source: string; count: number }>;
  } {
    const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (safeDays - 1));
    const startIso = start.toISOString();

    const dayRows = this.db
      .prepare(
        `SELECT substr(first_seen_at, 1, 10) AS day, COUNT(*) AS c
         FROM leads
         WHERE datetime(first_seen_at) >= datetime(?)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(startIso) as Array<{ day: string; c: number }>;

    const counts = new Map(dayRows.map((r) => [r.day, r.c]));
    const leadsPerDay: Array<{ date: string; count: number }> = [];
    for (let i = 0; i < safeDays; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      leadsPerDay.push({ date: key, count: counts.get(key) ?? 0 });
    }

    const byType = (
      this.db
        .prepare(
          `SELECT COALESCE(NULLIF(trim(treatment_type), ''), 'Unknown') AS type, COUNT(*) AS c
           FROM leads GROUP BY type ORDER BY c DESC, type ASC`,
        )
        .all() as Array<{ type: string; c: number }>
    ).map((r) => ({ type: r.type, count: r.c }));

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

    return { leadsPerDay, byType, byStage, bySource };
  }

  close(): void {
    this.db.close();
  }
}
