import { randomUUID } from "node:crypto";
import type {
  LeadfloAction,
  LeadfloClient,
  LeadfloPatient,
} from "./types.js";

const FIXTURE_ACTIONS: LeadfloAction[] = [
  {
    patient_id: "mock-asif-test",
    stage: "newLead",
    first_name: "asif",
    last_name: "test",
    phone: "07599 211739",
    type: "Implant",
    date: "2026-08-07",
    source: "Practice Website",
    email: "asif@smilefast.com",
    labels: ["Completed Implant Contact Form"],
  },
  {
    patient_id: "mock-real-patient",
    stage: "newLead",
    first_name: "Jane",
    last_name: "Smith",
    phone: "07700 900123",
    type: "Implant",
    date: "2026-08-07",
    source: "Google Ads",
    email: "jane@example.com",
    labels: [],
  },
  {
    patient_id: "mock-whitening",
    stage: "newLead",
    first_name: "Bob",
    last_name: "test",
    phone: "07700 900999",
    type: "Whitening",
    date: "2026-08-07",
    source: "Practice Website",
    email: "bob@example.com",
    labels: [],
  },
];

const patients = new Map<string, LeadfloPatient>(
  FIXTURE_ACTIONS.map((a) => [
    a.patient_id,
    {
      id: a.patient_id,
      first_name: a.first_name,
      last_name: a.last_name,
      email: a.email ?? null,
      phone: a.phone,
      type: a.type,
      source: a.source ?? null,
      labels: a.labels ?? [],
      stage: a.stage,
    },
  ]),
);

export const mockNotes: Array<{
  patientId: string;
  id: string;
  title: string;
  content: string;
  at: string;
}> = [];

export class MockLeadfloClient implements LeadfloClient {
  async login(): Promise<void> {
    /* no-op */
  }

  async ensureSession(): Promise<void> {
    /* no-op */
  }

  async getDueActions(stages: string[]): Promise<LeadfloAction[]> {
    return FIXTURE_ACTIONS.filter((a) => stages.includes(a.stage));
  }

  async getPatient(patientId: string): Promise<LeadfloPatient> {
    const p = patients.get(patientId);
    if (!p) throw new Error(`Mock patient not found: ${patientId}`);
    return { ...p };
  }

  async addNote(patientId: string, content: string, title = ""): Promise<void> {
    if (!patients.has(patientId)) {
      throw new Error(`Mock patient not found: ${patientId}`);
    }
    mockNotes.push({
      patientId,
      id: randomUUID(),
      title,
      content,
      at: new Date().toISOString(),
    });
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "mock mode" };
  }
}
