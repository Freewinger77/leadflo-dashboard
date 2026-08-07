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

export interface LeadfloClient {
  login(): Promise<void>;
  ensureSession(): Promise<void>;
  getDueActions(stages: string[]): Promise<LeadfloAction[]>;
  getPatient(patientId: string): Promise<LeadfloPatient>;
  addNote(patientId: string, content: string, title?: string): Promise<void>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
