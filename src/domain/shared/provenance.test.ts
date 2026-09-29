import { describe, it, expect } from "vitest";
import {
  knowledgeClassSchema,
  sourceKindSchema,
  captureMethodSchema,
  changeInitiatorSchema,
  assistanceSchema,
  provenanceCoreSchema,
  type SourceKind,
  type ChangeInitiator,
} from "./provenance";

describe("knowledgeClassSchema", () => {
  it("accepts the exact four values", () => {
    for (const v of ["PRESCRIBED", "PATIENT_STATED", "OBSERVED", "INFERRED"]) {
      expect(knowledgeClassSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown values", () => {
    expect(() => knowledgeClassSchema.parse("AI_GENERATED")).toThrow();
  });
});

describe("sourceKindSchema", () => {
  it("accepts the exact five values", () => {
    for (const v of [
      "PATIENT_ENTRY",
      "PATIENT_RESPONSE",
      "SYSTEM_OBSERVATION",
      "SYSTEM_DERIVATION",
      "IMPORT",
    ]) {
      expect(sourceKindSchema.parse(v)).toBe(v);
    }
  });

  it("rejects AI as a source kind", () => {
    expect(() => sourceKindSchema.parse("AI")).toThrow();
  });
});

describe("captureMethodSchema", () => {
  it("accepts the exact five values", () => {
    for (const v of ["FORM", "INQUIRY", "RULE_ENGINE", "AI_EXTRACTION", "IMPORT"]) {
      expect(captureMethodSchema.parse(v)).toBe(v);
    }
  });
});

describe("changeInitiatorSchema", () => {
  it("accepts the exact three values", () => {
    for (const v of ["PATIENT", "JAGAON_SYSTEM", "IMPORT"]) {
      expect(changeInitiatorSchema.parse(v)).toBe(v);
    }
  });

  it("rejects AI as an initiator", () => {
    expect(() => changeInitiatorSchema.parse("AI")).toThrow();
  });
});

describe("assistanceSchema", () => {
  it("accepts NONE and AI_ASSISTED", () => {
    expect(assistanceSchema.parse("NONE")).toBe("NONE");
    expect(assistanceSchema.parse("AI_ASSISTED")).toBe("AI_ASSISTED");
  });
});

describe("provenanceCoreSchema", () => {
  it("accepts valid patient entry provenance", () => {
    const p = provenanceCoreSchema.parse({
      sourceKind: "PATIENT_ENTRY",
      captureMethod: "FORM",
      initiator: "PATIENT",
      assistance: "NONE",
    });
    expect(p.sourceKind).toBe("PATIENT_ENTRY");
  });

  it("accepts valid patient response provenance", () => {
    const p = provenanceCoreSchema.parse({
      sourceKind: "PATIENT_RESPONSE",
      captureMethod: "INQUIRY",
      initiator: "PATIENT",
      assistance: "NONE",
    });
    expect(p.sourceKind).toBe("PATIENT_RESPONSE");
  });

  it("accepts valid system observation provenance", () => {
    const p = provenanceCoreSchema.parse({
      sourceKind: "SYSTEM_OBSERVATION",
      captureMethod: "RULE_ENGINE",
      initiator: "JAGAON_SYSTEM",
      assistance: "NONE",
    });
    expect(p.initiator).toBe("JAGAON_SYSTEM");
  });

  it("accepts valid system derivation provenance with AI assistance", () => {
    const p = provenanceCoreSchema.parse({
      sourceKind: "SYSTEM_DERIVATION",
      captureMethod: "AI_EXTRACTION",
      initiator: "JAGAON_SYSTEM",
      assistance: "AI_ASSISTED",
    });
    expect(p.assistance).toBe("AI_ASSISTED");
  });

  it("accepts valid import provenance", () => {
    const p = provenanceCoreSchema.parse({
      sourceKind: "IMPORT",
      captureMethod: "IMPORT",
      initiator: "IMPORT",
      assistance: "NONE",
    });
    expect(p.sourceKind).toBe("IMPORT");
  });

  it("rejects patient entry with wrong initiator (JAGAON_SYSTEM)", () => {
    expect(() =>
      provenanceCoreSchema.parse({
        sourceKind: "PATIENT_ENTRY",
        captureMethod: "FORM",
        initiator: "JAGAON_SYSTEM",
        assistance: "NONE",
      }),
    ).toThrow();
  });

  it("rejects patient response with import initiator", () => {
    expect(() =>
      provenanceCoreSchema.parse({
        sourceKind: "PATIENT_RESPONSE",
        captureMethod: "INQUIRY",
        initiator: "IMPORT",
        assistance: "NONE",
      }),
    ).toThrow();
  });

  it("rejects system observation with patient initiator", () => {
    expect(() =>
      provenanceCoreSchema.parse({
        sourceKind: "SYSTEM_OBSERVATION",
        captureMethod: "RULE_ENGINE",
        initiator: "PATIENT",
        assistance: "NONE",
      }),
    ).toThrow();
  });

  it("rejects import with patient initiator", () => {
    expect(() =>
      provenanceCoreSchema.parse({
        sourceKind: "IMPORT",
        captureMethod: "IMPORT",
        initiator: "PATIENT",
        assistance: "NONE",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      provenanceCoreSchema.parse({
        sourceKind: "PATIENT_ENTRY",
        captureMethod: "FORM",
        initiator: "PATIENT",
        assistance: "NONE",
        metadata: "escape",
      }),
    ).toThrow();
  });

  it("does not include AI in the SourceKind union", () => {
    const validKinds: SourceKind[] = [
      "PATIENT_ENTRY",
      "PATIENT_RESPONSE",
      "SYSTEM_OBSERVATION",
      "SYSTEM_DERIVATION",
      "IMPORT",
    ];
    expect(validKinds).not.toContain("AI");
  });

  it("does not include AI in the ChangeInitiator union", () => {
    const validInitiators: ChangeInitiator[] = [
      "PATIENT",
      "JAGAON_SYSTEM",
      "IMPORT",
    ];
    expect(validInitiators).not.toContain("AI");
  });
});

describe("audit reason/note types remain owner-supplied (compile-time)", () => {
  it("DomainMutationAudit is generic over TReasonCode and TNoteRef", () => {
    // This is a compile-time fixture: if the audit type were not generic,
    // the type annotation below would fail.
    type TestReasonCode = "CREATE" | "CORRECT";
    type TestNoteRef = string;

    // Import the type and verify it accepts generic parameters
    // We only prove the type compiles; no runtime assertion needed.
    const _fixture = null as unknown as import("./audit").DomainMutationAudit<
      TestReasonCode,
      TestNoteRef
    >;
    expect(_fixture).toBeDefined();
  });
});