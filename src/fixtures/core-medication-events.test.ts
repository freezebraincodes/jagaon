import { describe, expect, it } from "vitest";
import { medicationEventPayloadSchema } from "../domain/health-records";
import { coreMedicationEvents } from "./core-medication-events";

describe("coreMedicationEvents fixtures", () => {
  it("exports a readonly synthetic catalogue whose entries remain valid", () => {
    expect(Object.isFrozen(coreMedicationEvents)).toBe(true);

    for (const fixture of Object.values(coreMedicationEvents)) {
      expect(() => medicationEventPayloadSchema.parse(fixture)).not.toThrow();
    }
  });

  it("keeps an explicitly missed occasion distinct from absence of an event", () => {
    expect(coreMedicationEvents.explicitlyMissedDose.state).toBe("MISSED");
    expect(coreMedicationEvents.explicitlyMissedDose.intendedOccasion).toBeDefined();
  });

  it("keeps MISSED, UNSURE, and DECLINED_TO_RECORD distinct", () => {
    const states = new Set([
      coreMedicationEvents.explicitlyMissedDose.state,
      coreMedicationEvents.unsureWhetherTaken.state,
      coreMedicationEvents.declinedToRecord.state,
    ]);

    expect(states.size).toBe(3);
  });

  it("keeps an unrecorded amount distinct from uncertainty about taking the dose", () => {
    const taken = coreMedicationEvents.takenAmountNotRecorded;
    expect(taken.state).toBe("TAKEN");
    if (taken.state !== "TAKEN") throw new Error("Expected TAKEN fixture");
    expect(taken.amountTaken.kind).toBe("NOT_RECORDED");
    expect(coreMedicationEvents.unsureWhetherTaken.state).toBe("UNSURE");
  });

  it("allows a later taken event to resolve without erasing a delayed event", () => {
    expect(coreMedicationEvents.delayedDose.state).toBe("DELAYED");
    const taken = coreMedicationEvents.takenAfterDelay;
    expect(taken.state).toBe("TAKEN");
    if (taken.state !== "TAKEN") throw new Error("Expected TAKEN fixture");
    expect(taken.resolvesDelayedEvent?.recordType).toBe("MEDICATION_EVENT");
  });

  it("preserves all five closed medication safety concerns", () => {
    expect(coreMedicationEvents.allSafetyConcerns.reportedSafetyConcerns).toEqual(
      [
        "POSSIBLE_EXTRA_DOSE",
        "POSSIBLE_DOUBLE_DOSE",
        "POSSIBLE_WRONG_MEDICATION",
        "POSSIBLE_WRONG_AMOUNT",
        "DEVICE_OR_DELIVERY_ISSUE",
      ],
    );
  });

  it("leaves an unmatched prescription absent instead of guessing", () => {
    expect(
      coreMedicationEvents.unmatchedPrescriptionTaken.prescriptionVersion,
    ).toBeUndefined();
  });
});
