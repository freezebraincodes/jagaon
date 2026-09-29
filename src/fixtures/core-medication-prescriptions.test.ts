import { describe, it, expect } from "vitest";
import { coreMedicationPrescriptions } from "./core-medication-prescriptions";

describe("coreMedicationPrescriptions fixtures", () => {
  it("exports a readonly object", () => {
    expect(Object.isFrozen(coreMedicationPrescriptions)).toBe(true);
  });

  it("insulin pen has separate form, route, and device fields", () => {
    const m = coreMedicationPrescriptions.insulinPenMedication;
    expect(m.doseForm).toBe("INJECTION_SOLUTION");
    expect(m.route).toBe("SUBCUTANEOUS");
    expect(m.deliveryDevice).toBe("INSULIN_PEN");
  });

  it("reviewed catalogue match preserves patientEnteredName", () => {
    const m = coreMedicationPrescriptions.insulinPenMedication;
    expect(m.identity.kind).toBe("REVIEWED_CATALOGUE_MATCH");
    if (m.identity.kind === "REVIEWED_CATALOGUE_MATCH") {
      expect(m.identity.patientEnteredName).toBe("Insulin");
    }
  });

  it("unmapped medication preserves patientEnteredName", () => {
    const m = coreMedicationPrescriptions.unmappedMedication;
    expect(m.identity.kind).toBe("UNMAPPED");
    if (m.identity.kind === "UNMAPPED") {
      expect(m.identity.patientEnteredName).toBe("My herbal supplement");
    }
  });

  it("fixed dose instruction remains distinct from variable and unstructured", () => {
    expect(
      coreMedicationPrescriptions.fixedDoseInsulin.doseInstruction.kind,
    ).toBe("FIXED");
  });

  it("variable plan retains all reported amounts without choosing one", () => {
    const variable = coreMedicationPrescriptions.variableDoseInsulin;
    if (variable.doseInstruction.kind === "VARIABLE_PER_REPORTED_PLAN") {
      expect(variable.doseInstruction.reportedAmounts).toHaveLength(2);
    }
  });

  it("source instruction text survives structural extraction", () => {
    expect(
      coreMedicationPrescriptions.fixedDoseInsulin.sourceInstructionText.text,
    ).toBe("Take 10 units before breakfast");
  });

  it("unknown effective start is not substituted", () => {
    expect(
      coreMedicationPrescriptions.fixedDoseInsulin.effectivePeriod.start.kind,
    ).toBe("UNKNOWN");
  });

  it("unstructured instruction remains unstructured in dose and schedule", () => {
    const u = coreMedicationPrescriptions.unstructuredPrescription;
    expect(u.doseInstruction.kind).toBe("UNSTRUCTURED");
    expect(u.schedule.kind).toBe("UNSTRUCTURED");
  });
});