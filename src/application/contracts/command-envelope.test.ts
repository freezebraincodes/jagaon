import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import * as barrel from "./index";
import {
  recordHeadExpectationSchema,
  createCommandEnvelopeSchema,
  type RecordHeadExpectation,
  type CommandEnvelope,
} from "./command-envelope";
import {
  patientSettingsCommandNameSchema,
  type PatientSettingsCommandName,
} from "./command-event-names";
import {
  type CommandName,
} from "./command-event-names";
import {
  type Instant,
} from "@/domain/shared/time";
import {
  type RecordId,
} from "@/domain/shared/identifiers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const UUID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_INSTANT = "2026-09-28T10:00:00Z";
const VALID_RECORD_TYPE = "PATIENT_PROFILE";
const VALID_RECORD_ID = UUID_V4 as RecordId;
const VALID_REVISION_ID = UUID_V4 as unknown as import("@/domain/shared/identifiers").RevisionId;

const validMustNotExistExpectation = {
  kind: "MUST_NOT_EXIST" as const,
  recordType: VALID_RECORD_TYPE,
  proposedRecordId: VALID_RECORD_ID,
};

const validMustMatchExpectation = {
  kind: "MUST_MATCH" as const,
  recordType: VALID_RECORD_TYPE,
  recordId: VALID_RECORD_ID,
  expectedRevisionId: VALID_REVISION_ID,
  expectedRevisionNumber: 3,
};

// A strict command-specific payload schema for testing.
const testPayloadSchema = z
  .object({
    label: z.string().min(1).max(50),
    value: z.number().int().nonnegative(),
  })
  .strict();

type TestPayload = z.infer<typeof testPayloadSchema>;

const validPayload: TestPayload = { label: "reading", value: 7 };

const envelopeSchema = createCommandEnvelopeSchema(
  patientSettingsCommandNameSchema,
  testPayloadSchema,
);

const validEnvelopeInput = {
  schemaVersion: 1,
  commandId: UUID_V4,
  commandName: "CREATE_PATIENT_PROFILE",
  issuedAt: VALID_INSTANT,
  initiator: "PATIENT",
  assistance: "NONE",
  origin: "PATIENT_UI",
  correlationId: UUID_V4,
  cause: { kind: "DIRECT_PATIENT_ACTION" },
  headExpectations: [validMustMatchExpectation],
  payload: validPayload,
};

// ---------------------------------------------------------------------------
// RecordHeadExpectation schema
// ---------------------------------------------------------------------------

describe("recordHeadExpectationSchema — MUST_NOT_EXIST variant", () => {
  it("accepts a valid MUST_NOT_EXIST expectation", () => {
    const result = recordHeadExpectationSchema.parse(validMustNotExistExpectation);
    expect(result).toEqual(validMustNotExistExpectation);
    expect(result.kind).toBe("MUST_NOT_EXIST");
  });

  it("rejects an invalid record type", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustNotExistExpectation,
        recordType: "NOT_A_REAL_RECORD_TYPE",
      }),
    ).toThrow();
  });

  it("rejects an invalid proposedRecordId", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustNotExistExpectation,
        proposedRecordId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustNotExistExpectation,
        extra: "sneaky",
      }),
    ).toThrow();
  });

  it("rejects a missing proposedRecordId", () => {
    const { proposedRecordId, ...rest } = validMustNotExistExpectation;
    void proposedRecordId;
    expect(() => recordHeadExpectationSchema.parse(rest)).toThrow();
  });
});

describe("recordHeadExpectationSchema — MUST_MATCH variant", () => {
  it("accepts a valid MUST_MATCH expectation", () => {
    const result = recordHeadExpectationSchema.parse(validMustMatchExpectation);
    expect(result).toEqual(validMustMatchExpectation);
    expect(result.kind).toBe("MUST_MATCH");
  });

  it("rejects an invalid record type", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        recordType: "BOGUS",
      }),
    ).toThrow();
  });

  it("rejects an invalid recordId", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        recordId: "definitely-not-uuid",
      }),
    ).toThrow();
  });

  it("rejects an invalid expectedRevisionId", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        expectedRevisionId: 42,
      }),
    ).toThrow();
  });

  it("rejects zero revision number", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        expectedRevisionNumber: 0,
      }),
    ).toThrow();
  });

  it("rejects negative revision number", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        expectedRevisionNumber: -1,
      }),
    ).toThrow();
  });

  it("rejects fractional revision number", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        expectedRevisionNumber: 2.5,
      }),
    ).toThrow();
  });

  it("rejects unsafe revision number above MAX_SAFE_INTEGER", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        expectedRevisionNumber: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      recordHeadExpectationSchema.parse({
        ...validMustMatchExpectation,
        unexpected: true,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandEnvelope typed schema factory
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — valid envelope", () => {
  it("parses a valid typed command envelope", () => {
    const result = envelopeSchema.parse(validEnvelopeInput);
    expect(result.commandName).toBe("CREATE_PATIENT_PROFILE");
    expect(result.payload).toEqual(validPayload);
    expect(result.headExpectations).toHaveLength(1);
  });

  it("preserves the specific command name type", () => {
    const result = envelopeSchema.parse(validEnvelopeInput);
    expectTypeOf(result.commandName).toEqualTypeOf<PatientSettingsCommandName>();
  });

  it("preserves the specific payload type", () => {
    const result = envelopeSchema.parse(validEnvelopeInput);
    expectTypeOf(result.payload).toEqualTypeOf<TestPayload>();
  });

  it("preserves the full envelope type parameters", () => {
    expectTypeOf<CommandEnvelope<PatientSettingsCommandName, TestPayload>>()
      .toMatchTypeOf<CommandEnvelope<CommandName, TestPayload>>();
  });

  it("accepts an empty headExpectations array", () => {
    const result = envelopeSchema.parse({
      ...validEnvelopeInput,
      headExpectations: [],
    });
    expect(result.headExpectations).toEqual([]);
  });

  it("accepts both head-expectation variants together", () => {
    const result = envelopeSchema.parse({
      ...validEnvelopeInput,
      headExpectations: [validMustNotExistExpectation, validMustMatchExpectation],
    });
    expect(result.headExpectations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// CommandEnvelope — command name constraints
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — command name outside supplied schema", () => {
  it("rejects a command name not in the supplied name schema", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        commandName: "REGISTER_MEDICATION",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandEnvelope — field-level rejections
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — invalid fields", () => {
  it("rejects a zero schemaVersion", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, schemaVersion: 0 }),
    ).toThrow();
  });

  it("rejects a negative schemaVersion", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, schemaVersion: -1 }),
    ).toThrow();
  });

  it("rejects a fractional schemaVersion", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, schemaVersion: 1.5 }),
    ).toThrow();
  });

  it("rejects an unsafe schemaVersion above MAX_SAFE_INTEGER", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        schemaVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("rejects an invalid commandId", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, commandId: "bad" }),
    ).toThrow();
  });

  it("rejects an invalid timestamp", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        issuedAt: "2026-09-28T10:00:00+08:00",
      }),
    ).toThrow();
  });

  it("rejects an invalid initiator", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, initiator: "DOCTOR" }),
    ).toThrow();
  });

  it("rejects an invalid assistance", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, assistance: "HUMAN" }),
    ).toThrow();
  });

  it("rejects an invalid origin", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, origin: "AI_AGENT" }),
    ).toThrow();
  });

  it("rejects an invalid cause", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        cause: { kind: "MYSTERIOUS" },
      }),
    ).toThrow();
  });

  it("rejects an invalid head expectation inside the array", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        headExpectations: [
          { ...validMustMatchExpectation, expectedRevisionNumber: 0 },
        ],
      }),
    ).toThrow();
  });

  it("rejects an invalid correlationId", () => {
    expect(() =>
      envelopeSchema.parse({ ...validEnvelopeInput, correlationId: "nope" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandEnvelope — unknown fields
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — unknown envelope fields", () => {
  it("rejects an unknown top-level field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        sneaky: "data",
      }),
    ).toThrow();
  });

  it("rejects an unknown field in payload when using a strict payload schema", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        payload: { ...validPayload, extra: "no" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Excluded fields
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — excluded escape-hatch fields", () => {
  it("rejects a generic confirmed field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        confirmed: true,
      }),
    ).toThrow();
  });

  it("rejects an AI-origin field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        aiOrigin: "GPT-4",
      }),
    ).toThrow();
  });

  it("rejects a generic mutation field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        mutation: { recordType: "PATIENT_PROFILE", patch: {} },
      }),
    ).toThrow();
  });

  it("rejects unrestricted metadata field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        metadata: { anything: true },
      }),
    ).toThrow();
  });

  it("rejects an extension escape-hatch field", () => {
    expect(() =>
      envelopeSchema.parse({
        ...validEnvelopeInput,
        extensions: {},
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

describe("barrel re-exports", () => {
  it("re-exports the new contracts from index", () => {
    expect(barrel.recordHeadExpectationSchema).toBeDefined();
    expect(barrel.createCommandEnvelopeSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Compile-time: arbitrary non-command string literals rejected by factory
// ---------------------------------------------------------------------------

describe("createCommandEnvelopeSchema — compile-time name constraint", () => {
  it("accepts an approved subset name schema at the type level", () => {
    // This compiles only because patientSettingsCommandNameSchema infers
    // to an approved CommandName subset.
    const _schema = createCommandEnvelopeSchema(
      patientSettingsCommandNameSchema,
      testPayloadSchema,
    );
    void _schema;
    expect(true).toBe(true);
  });

  it("rejects an arbitrary non-command literal at compile time", () => {
    // @ts-expect-error — arbitrary literals are not approved CommandName values
    createCommandEnvelopeSchema(z.literal("DO_SOMETHING_RANDOM"), testPayloadSchema);
  });

  it("preserves the approved command name in the inferred output type", () => {
    const schema = createCommandEnvelopeSchema(
      patientSettingsCommandNameSchema,
      testPayloadSchema,
    );
    type Output = z.infer<typeof schema>;
    expectTypeOf<Output["commandName"]>().toEqualTypeOf<PatientSettingsCommandName>();
  });
});
