import { describe, expect, it } from "vitest";
import {
  prescriptionChangeCandidatePayloadSchema,
  prescriptionChangeKindSchema,
} from "../domain/care-plan";
import { prescriptionChangeCandidates } from "./prescription-change-candidates";

describe("prescriptionChangeCandidates fixtures", () => {
  it("exports a readonly synthetic catalogue whose entries remain valid", () => {
    expect(Object.isFrozen(prescriptionChangeCandidates)).toBe(true);

    for (const fixture of Object.values(prescriptionChangeCandidates)) {
      expect(() => prescriptionChangeCandidatePayloadSchema.parse(fixture)).not.toThrow();
    }
  });

  it("keeps the approved change-kind catalogue available at the public boundary", () => {
    expect(prescriptionChangeKindSchema.parse("TIMING_CHANGED")).toBe(
      "TIMING_CHANGED",
    );
    expect(() => prescriptionChangeKindSchema.parse("DIAGNOSIS_CHANGED")).toThrow();
  });

  it("preserves a pending report with unknown effective time", () => {
    const candidate = prescriptionChangeCandidates.pendingTimingChange;

    expect(candidate.reportedEffectiveFrom).toEqual({ kind: "UNKNOWN" });
    expect(candidate.reconciliation).toEqual({
      state: "PENDING_RECONCILIATION",
    });
  });

  it("preserves the structured dose candidate without selecting an amount", () => {
    const candidate =
      prescriptionChangeCandidates.pendingDoseChangeWithCandidate;

    expect(candidate.structuredCandidate?.doseInstruction).toEqual({
      kind: "FIXED",
      amount: { value: "12", unit: "UNIT" },
    });
    expect(candidate.reconciliation.state).toBe("PENDING_RECONCILIATION");
  });

  it("keeps verified reconciliation distinct from the original patient report", () => {
    const candidate =
      prescriptionChangeCandidates.reconciledWithVerifiedSource;

    expect(candidate.reportedNewInstructionText.text).toBe(
      "Doctor said take it at 9pm instead",
    );
    expect(candidate.reconciliation.state).toBe(
      "RECONCILED_WITH_VERIFIED_SOURCE",
    );
  });

  it("keeps conflicting and superseded lifecycle states distinct", () => {
    expect(
      prescriptionChangeCandidates.conflictingSource.reconciliation.state,
    ).toBe("CONFLICTING_SOURCE");
    expect(prescriptionChangeCandidates.superseded.reconciliation.state).toBe(
      "SUPERSEDED",
    );
  });
});
