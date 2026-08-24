export type LeadfloStage =
  | "newLead"
  | "callback1"
  | "callback2"
  | "callback3"
  | "working"
  | "thinking"
  | "consultation"
  | "txPlanConsult"
  | "inTx"
  | string;

export interface LeadfloAction {
  patient_id: string;
  stage: LeadfloStage;
  first_name: string;
  last_name: string;
  phone: string;
  type: string;
  date?: string;
  snooze?: { state?: string; ends_at?: string | null } | null;
  source?: string;
  email?: string;
  labels?: string[];
}

export interface LeadfloPatient {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
  source?: string | null;
  labels?: string[];
  stage?: string | null;
  gdpr?: boolean | null;
  [key: string]: unknown;
}

export interface NormalizedLead {
  patientId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string;
  treatmentType: string;
  source: string;
  stage: string;
  dueDate: string | null;
  labels: string[];
  isTestName: boolean;
  scrapedAt: string;
  raw?: unknown;
}

export interface NotePayload {
  id: string;
  title?: string;
  content: string;
}

export interface LeadfloTimelineItem {
  id: string;
  type: string;
  datetime: string;
  title?: string;
  content?: string;
  message?: string;
  form?: string;
  comm_type?: string;
  text_content?: string;
  inbound?: boolean;
  [key: string]: unknown;
}

export interface LeadfloNote {
  id: string;
  title: string;
  content: string;
  datetime: string;
}

/** Every stage Leadflo's action board knows about. */
export const ALL_LEADFLO_STAGES: LeadfloStage[] = [
  "newLead",
  "callback1",
  "callback2",
  "callback3",
  "working",
  "thinking",
  "consultation",
  "txPlanConsult",
  "inTx",
];

export interface ListPatientsQuery {
  /** Leadflo reporting window start (YYYY-MM-DD or ISO). */
  from: string;
  /** Leadflo reporting window end (YYYY-MM-DD or ISO). */
  to: string;
  /** SPA uses `pipeline` for the main patient table. */
  report?: string;
  types?: string[];
  stages?: string[];
  sources?: string[];
  labels?: string[];
  page?: number;
  limit?: number;
}

export interface ListPatientsResult {
  patients: LeadfloPatient[];
  total: number;
  page: number;
  limit: number;
}

export interface LeadfloClient {
  login(): Promise<void>;
  ensureSession(): Promise<void>;
  getDueActions(stages: string[]): Promise<LeadfloAction[]>;
  /**
   * Paginated patient table used by Leadflo's Pipeline reporting screen.
   * This is the only bulk path that can reach past / late-stage patients
   * that no longer appear on `/actions/due`.
   */
  listPatients(query: ListPatientsQuery): Promise<ListPatientsResult>;
  getPatient(patientId: string): Promise<LeadfloPatient>;
  getTimeline(patientId: string): Promise<LeadfloTimelineItem[]>;
  addNote(patientId: string, content: string, title?: string): Promise<void>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
