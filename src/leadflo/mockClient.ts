import { randomUUID } from "node:crypto";
import type {
  LeadfloAction,
  LeadfloClient,
  LeadfloPatient,
  LeadfloTimelineItem,
} from "./types.js";

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};

const FIXTURE_ACTIONS: LeadfloAction[] = [
  {
    patient_id: "mock-asif-test",
    stage: "newLead",
    first_name: "asif",
    last_name: "test",
    phone: "07599 211739",
    type: "Implant",
    date: `${day(0)}T10:00:00.000Z`,
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
    date: `${day(1)}T11:00:00.000Z`,
    source: "Google Ads",
    email: "jane@example.com",
    labels: [],
  },
  {
    patient_id: "mock-whitening",
    stage: "callback1",
    first_name: "Bob",
    last_name: "test",
    phone: "07700 900999",
    type: "Whitening",
    date: `${day(2)}T09:30:00.000Z`,
    source: "Practice Website",
    email: "bob@example.com",
    labels: [],
  },
  {
    patient_id: "mock-aligner",
    stage: "newLead",
    first_name: "Sam",
    last_name: "Lee",
    phone: "07700 900555",
    type: "Aligners",
    date: `${day(0)}T15:00:00.000Z`,
    source: "Facebook",
    email: "sam@example.com",
    labels: [],
  },
  {
    patient_id: "mock-implant-old",
    stage: "working",
    first_name: "Pat",
    last_name: "Jones",
    phone: "07700 900222",
    type: "Implant",
    date: `${day(5)}T14:00:00.000Z`,
    source: "Referral",
    email: "pat@example.com",
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
}> = [
  {
    patientId: "mock-asif-test",
    id: "note-seed-1",
    title: "",
    content: "Initial enquiry note from front desk",
    at: `${day(1)}T12:00:00.000Z`,
  },
];

const mockTimelineExtra: Record<string, LeadfloTimelineItem[]> = {
  "mock-asif-test": [
    {
      id: "form-asif",
      type: "form_submission",
      datetime: `${day(1)}T10:00:00.000Z`,
      message: "test",
      form: "Implant Contact Form",
    },
    {
      id: "sms-asif",
      type: "communication",
      datetime: `${day(1)}T10:01:00.000Z`,
      comm_type: "Automated SMS",
      text_content: "Hi asif, thanks for your enquiry…",
      inbound: false,
    },
  ],
};

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

  async getTimeline(patientId: string): Promise<LeadfloTimelineItem[]> {
    if (!patients.has(patientId)) {
      throw new Error(`Mock patient not found: ${patientId}`);
    }
    const notes: LeadfloTimelineItem[] = mockNotes
      .filter((n) => n.patientId === patientId)
      .map((n) => ({
        id: n.id,
        type: "note",
        datetime: n.at,
        title: n.title,
        content: n.content,
      }));
    const extra = mockTimelineExtra[patientId] ?? [];
    return [...extra, ...notes].sort((a, b) =>
      String(a.datetime).localeCompare(String(b.datetime)),
    );
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
