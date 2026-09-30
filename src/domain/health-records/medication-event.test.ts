import { describe, it, expect } from "vitest";
import {
  medicationEventPayloadSchema,
  medicationEventTemporalSchema,
  recordedMedicationAmountSchema,
  medicationSafetyConcernSchema,
  MEDICATION_EVENT_DELETION_POLICY,
  MEDICATION_EVENT_REVISION_ACTIONS,
  type MedicationEventPayload,
} from "./medication-event";
import { DeletionPolicy } from "../shared/record-catalogue";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

const MEDICATION_REF = {
  recordType: "MEDICATION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const PRESCRIPTION_VERSION_REF = {
  recordType: "PRESCRIPTION_VERSION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const MEDICATION_EVENT_REF = {
  recordType: "MEDICATION_EVENT" as const,
  recordId: UUID,
  revisionId: UUID,
};

const EXACT_TIME = {
  kind: "EXACT" as const,
  instantUtc: "2026-01-15T08:00:00Z",
  timeZoneId: "Asia/Singapore",
  utcOffsetMinutes: 480,
};

const OCCASION = {
  expectedAt: EXACT_TIME,
  prescriptionVersion: PRESCRIPTION_VERSION_REF,
  scheduleKey: "morning",
};

// --- TAKEN ---

describe("TAKEN event", () => {
  it("accepts TAKEN with KNOWN amount", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
    });
    expect(result.state).toBe("TAKEN");
    if (result.state === "TAKEN") {
      expect(result.amountTaken.kind).toBe("KNOWN");
    }
  });

  it("accepts TAKEN with NOT_RECORDED amount", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "NOT_RECORDED" },
    });
    if (result.state === "TAKEN") {
      expect(result.amountTaken.kind).toBe("NOT_RECORDED");
    }
  });

  it("accepts TAKEN with UNSURE amount", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "UNSURE" },
    });
    if (result.state === "TAKEN") {
      expect(result.amountTaken.kind).toBe("UNSURE");
    }
  });

  it("TAKEN with UNSURE amount differs from event state UNSURE", () => {
    const takenUnsure = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "UNSURE" },
    });
    const eventUnsure = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "UNSURE",
      intendedOccasion: OCCASION,
    });
    expect(takenUnsure.state).toBe("TAKEN");
    expect(eventUnsure.state).toBe("UNSURE");
  });

  it("rejects TAKEN without amountTaken", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "TAKEN",
      }),
    ).toThrow();
  });

  it("accepts resolvesDelayedEvent on TAKEN", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
      resolvesDelayedEvent: MEDICATION_EVENT_REF,
    });
    if (result.state === "TAKEN") {
      expect(result.resolvesDelayedEvent!.recordType).toBe("MEDICATION_EVENT");
    }
  });

  it("rejects resolvesDelayedEvent with wrong recordType", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "TAKEN",
        amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
        resolvesDelayedEvent: PRESCRIPTION_VERSION_REF,
      }),
    ).toThrow();
  });
});

// --- MISSED, DELAYED, UNSURE, DECLINED_TO_RECORD ---

describe("non-TAKEN event states", () => {
  it("accepts MISSED with intendedOccasion", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "MISSED",
      intendedOccasion: OCCASION,
    });
    expect(result.state).toBe("MISSED");
  });

  it("rejects MISSED without intendedOccasion", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "MISSED",
      }),
    ).toThrow();
  });

  it("accepts DELAYED with intendedOccasion", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "DELAYED",
      intendedOccasion: OCCASION,
    });
    expect(result.state).toBe("DELAYED");
  });

  it("accepts UNSURE with intendedOccasion", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "UNSURE",
      intendedOccasion: OCCASION,
    });
    expect(result.state).toBe("UNSURE");
  });

  it("accepts DECLINED_TO_RECORD with intendedOccasion", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "DECLINED_TO_RECORD",
      intendedOccasion: OCCASION,
    });
    expect(result.state).toBe("DECLINED_TO_RECORD");
  });

  it("MISSED, UNSURE, and DECLINED_TO_RECORD remain distinct", () => {
    const missed = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "MISSED",
      intendedOccasion: OCCASION,
    });
    const unsure = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "UNSURE",
      intendedOccasion: OCCASION,
    });
    const declined = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "DECLINED_TO_RECORD",
      intendedOccasion: OCCASION,
    });
    expect(new Set([missed.state, unsure.state, declined.state]).size).toBe(3);
  });
});

// --- resolvesDelayedEvent only on TAKEN ---

describe("resolvesDelayedEvent restriction", () => {
  it("rejects resolvesDelayedEvent on MISSED", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "MISSED",
        intendedOccasion: OCCASION,
        resolvesDelayedEvent: MEDICATION_EVENT_REF,
      }),
    ).toThrow();
  });

  it("rejects resolvesDelayedEvent on DELAYED", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "DELAYED",
        intendedOccasion: OCCASION,
        resolvesDelayedEvent: MEDICATION_EVENT_REF,
      }),
    ).toThrow();
  });
});

// --- Temporal schema ---

describe("medicationEventTemporalSchema", () => {
  it("accepts POINT with EXACT occurrence", () => {
    const result = medicationEventTemporalSchema.parse({
      kind: "POINT",
      occurrence: EXACT_TIME,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with UNKNOWN occurrence", () => {
    const result = medicationEventTemporalSchema.parse({
      kind: "POINT",
      occurrence: { kind: "UNKNOWN" },
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with DATE_ONLY occurrence", () => {
    const result = medicationEventTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "DATE_ONLY",
        localDate: "2026-01-15",
        timeZoneId: "Asia/Singapore",
      },
    });
    expect(result.kind).toBe("POINT");
  });

  it("rejects INTERVAL temporal", () => {
    expect(() =>
      medicationEventTemporalSchema.parse({
        kind: "INTERVAL",
        start: EXACT_TIME,
        end: { kind: "OPEN" },
      }),
    ).toThrow();
  });

  it("rejects ATEMPORAL temporal", () => {
    expect(() =>
      medicationEventTemporalSchema.parse({ kind: "ATEMPORAL" }),
    ).toThrow();
  });
});

// --- Safety concerns ---

describe("medicationSafetyConcernSchema", () => {
  it("accepts all five concern literals", () => {
    const concerns = [
      "POSSIBLE_EXTRA_DOSE",
      "POSSIBLE_DOUBLE_DOSE",
      "POSSIBLE_WRONG_MEDICATION",
      "POSSIBLE_WRONG_AMOUNT",
      "DEVICE_OR_DELIVERY_ISSUE",
    ];
    for (const c of concerns) {
      expect(medicationSafetyConcernSchema.parse(c)).toBe(c);
    }
  });

  it("rejects an unknown concern", () => {
    expect(() => medicationSafetyConcernSchema.parse("WRONG_TIME")).toThrow();
  });

  it("accepts a non-empty array of concerns", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
      reportedSafetyConcerns: [
        "POSSIBLE_EXTRA_DOSE",
        "DEVICE_OR_DELIVERY_ISSUE",
      ],
    });
    if (result.state === "TAKEN") {
      expect(result.reportedSafetyConcerns).toHaveLength(2);
    }
  });

  it("rejects an empty concerns array", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "TAKEN",
        amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
        reportedSafetyConcerns: [],
      }),
    ).toThrow();
  });
});

// --- Strict-object rejection ---

describe("strict-object rejection", () => {
  it("rejects unknown keys on TAKEN", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "TAKEN",
        amountTaken: { kind: "NOT_RECORDED" },
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects unknown keys on MedicationOccasion", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
        state: "MISSED",
        intendedOccasion: { ...OCCASION, extra: true },
      }),
    ).toThrow();
  });

  it("rejects wrong recordType on medication ref", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: PRESCRIPTION_VERSION_REF,
        state: "TAKEN",
        amountTaken: { kind: "NOT_RECORDED" },
      }),
    ).toThrow();
  });

  it("rejects bare identifier on medication ref", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: UUID,
        state: "TAKEN",
        amountTaken: { kind: "NOT_RECORDED" },
      }),
    ).toThrow();
  });

  it("rejects wrong recordType on prescriptionVersion ref", () => {
    expect(() =>
      medicationEventPayloadSchema.parse({
        medication: MEDICATION_REF,
          prescriptionVersion: MEDICATION_REF,
          state: "TAKEN",
        amountTaken: { kind: "NOT_RECORDED" },
      }),
    ).toThrow();
  });
});

// --- Optional prescription remains absent ---

describe("optional prescription version", () => {
  it("prescriptionVersion is optional and not guessed", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "NOT_RECORDED" },
    });
    expect(result.prescriptionVersion).toBeUndefined();
  });

  it("intendedOccasion prescriptionVersion is optional", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "MISSED",
      intendedOccasion: {
        expectedAt: EXACT_TIME,
      },
    });
    if (result.state === "MISSED") {
      expect(result.intendedOccasion.prescriptionVersion).toBeUndefined();
    }
  });
});

// --- Text preservation ---

describe("patient-authored text preservation", () => {
  it("preserves patientStatedReason unchanged", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "TAKEN",
      amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } },
      patientStatedReason: {
        text: "I felt dizzy so I took it late",
        language: "en-SG",
      },
    });
    expect(result.patientStatedReason!.text).toBe(
      "I felt dizzy so I took it late",
    );
  });

  it("preserves patientNote unchanged", () => {
    const result = medicationEventPayloadSchema.parse({
      medication: MEDICATION_REF,
      state: "MISSED",
      intendedOccasion: OCCASION,
      patientNote: { text: "Was at the clinic", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Was at the clinic");
  });
});

// --- Shared boundaries ---

describe("MEDICATION_EVENT shared boundaries", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(MEDICATION_EVENT_DELETION_POLICY).toBe(
      DeletionPolicy.PATIENT_DELETABLE,
    );
  });

  it("has exactly CREATE, CORRECT", () => {
    expect(MEDICATION_EVENT_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
    ]);
  });

  it("does not include CONFIRM", () => {
    expect(MEDICATION_EVENT_REVISION_ACTIONS).not.toContain("CONFIRM");
  });
});
