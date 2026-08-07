import { config } from "../config.js";
import type { Store } from "../db/store.js";
import type { LeadfloClient } from "../leadflo/index.js";

export interface AiNoteRequest {
  patientId: string;
  note: string;
  title?: string;
  /** Force write even if name is not a test name (overrides NOTES_ONLY_TEST_NAMES) */
  force?: boolean;
}

export async function applyAiNote(
  store: Store,
  client: LeadfloClient,
  req: AiNoteRequest,
): Promise<{
  ok: boolean;
  status: string;
  message: string;
}> {
  const lead = store.getLead(req.patientId);
  if (!lead) {
    return {
      ok: false,
      status: "unknown_lead",
      message: `Lead ${req.patientId} is not tracked. Scrape first or check patientId.`,
    };
  }

  const note = req.note?.trim();
  if (!note) {
    return { ok: false, status: "invalid", message: "note is required" };
  }

  store.setStatus(lead.patient_id, "ai_received", {
    ai_response_at: new Date().toISOString(),
    ai_note: note,
    last_error: null,
  });
  store.logEvent("ai.received", `AI note received (${note.length} chars)`, lead.patient_id);

  const allowWrite =
    req.force === true || !config.notesOnlyTestNames || lead.is_test_name === 1;

  if (!allowWrite) {
    store.setStatus(lead.patient_id, "note_skipped", {
      last_error: null,
    });
    store.logEvent(
      "note.skipped",
      `Skipped writing note for "${lead.full_name}" (NOTES_ONLY_TEST_NAMES=true)`,
      lead.patient_id,
    );
    return {
      ok: true,
      status: "note_skipped",
      message:
        "AI response stored, but Leadflo note was not written because the name does not contain 'test'.",
    };
  }

  try {
    await client.addNote(lead.patient_id, note, req.title ?? "");
    store.setStatus(lead.patient_id, "note_written", {
      note_written_at: new Date().toISOString(),
      last_error: null,
    });
    store.logEvent(
      "note.written",
      `Wrote note to Leadflo for ${lead.full_name}`,
      lead.patient_id,
    );
    return {
      ok: true,
      status: "note_written",
      message: `Note written to Leadflo for ${lead.full_name}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setStatus(lead.patient_id, "note_failed", { last_error: message });
    store.logEvent("note.failed", message, lead.patient_id);
    return { ok: false, status: "note_failed", message };
  }
}
