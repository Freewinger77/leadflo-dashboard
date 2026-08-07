import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTestName,
  isTrackedTreatment,
  normalizeLead,
} from "../src/leadflo/index.js";

describe("lead filters", () => {
  it("tracks implant types case-insensitively", () => {
    assert.equal(isTrackedTreatment("Implant"), true);
    assert.equal(isTrackedTreatment("implant"), true);
    assert.equal(isTrackedTreatment("Whitening"), false);
  });

  it("detects test names", () => {
    assert.equal(isTestName("asif test"), true);
    assert.equal(isTestName("Jane Smith"), false);
  });

  it("normalizes action + patient", () => {
    const lead = normalizeLead(
      {
        patient_id: "p1",
        stage: "newLead",
        first_name: "asif",
        last_name: "test",
        phone: "07599 211739",
        type: "Implant",
        date: "2026-08-07",
      },
      {
        id: "p1",
        first_name: "asif",
        last_name: "test",
        email: "asif@smilefast.com",
        phone: "07599 211739",
        type: "Implant",
        source: "Practice Website",
        labels: ["Completed Implant Contact Form"],
      },
    );
    assert.equal(lead.fullName, "asif test");
    assert.equal(lead.isTestName, true);
    assert.equal(lead.email, "asif@smilefast.com");
    assert.equal(lead.source, "Practice Website");
  });
});
