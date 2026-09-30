import { describe, it, expect } from "vitest";
import * as barrel from "./index";
import {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
  eventSequenceSchema,
  createCommandId,
  createCorrelationId,
  createDomainEventId,
  COMMAND_ORIGINS,
  commandOriginSchema,
  commandCauseSchema,
  type CommandId,
  type CorrelationId,
  type DomainEventId,
  type CommandCause,
} from "./command-event-identifiers";

const FIXED_UUID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const NON_V4_UUID = "f47ac10b-58cc-5372-a567-0e02b2c3d479";
const VALID_INSTANT = "2026-09-28T10:00:00Z";
const INVALID_INSTANT = "2026-09-28T10:00:00+08:00";

// ---------------------------------------------------------------------------
// Identifier schemas
// ---------------------------------------------------------------------------

describe("identifier schemas", () => {
  it.each([
    ["commandIdSchema", commandIdSchema],
    ["correlationIdSchema", correlationIdSchema],
    ["domainEventIdSchema", domainEventIdSchema],
  ])("%s accepts a valid UUID v4", (_name, schema) => {
    expect(schema.parse(FIXED_UUID_V4)).toBe(FIXED_UUID_V4);
  });

  it.each([
    ["commandIdSchema", commandIdSchema],
    ["correlationIdSchema", correlationIdSchema],
    ["domainEventIdSchema", domainEventIdSchema],
  ])("%s rejects a non-v4 UUID", (_name, schema) => {
    expect(() => schema.parse(NON_V4_UUID)).toThrow();
  });

  it.each([
    ["commandIdSchema", commandIdSchema],
    ["correlationIdSchema", correlationIdSchema],
    ["domainEventIdSchema", domainEventIdSchema],
  ])("%s rejects a malformed string", (_name, schema) => {
    expect(() => schema.parse("not-a-uuid")).toThrow();
  });

  it.each([
    ["commandIdSchema", commandIdSchema],
    ["correlationIdSchema", correlationIdSchema],
    ["domainEventIdSchema", domainEventIdSchema],
  ])("%s rejects an empty string", (_name, schema) => {
    expect(() => schema.parse("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Identifier generators
// ---------------------------------------------------------------------------

describe("identifier generators", () => {
  it.each([
    ["createCommandId", createCommandId, commandIdSchema],
    ["createCorrelationId", createCorrelationId, correlationIdSchema],
    ["createDomainEventId", createDomainEventId, domainEventIdSchema],
  ])("%s returns a value accepted by its schema", (_name, gen, schema) => {
    const id = gen();
    expect(schema.parse(id)).toBe(id);
  });

  it("generators produce unique values", () => {
    expect(createCommandId()).not.toBe(createCommandId());
    expect(createCorrelationId()).not.toBe(createCorrelationId());
    expect(createDomainEventId()).not.toBe(createDomainEventId());
  });
});

// ---------------------------------------------------------------------------
// Brand distinctness (compile-time)
// ---------------------------------------------------------------------------

describe("branded type distinctness (compile-time)", () => {
  it("a CommandId cannot be assigned where a CorrelationId is required", () => {
    function takeCorrelation(_id: CorrelationId): void {}

    const cid: CommandId = FIXED_UUID_V4 as CommandId;
    // @ts-expect-error: CommandId is not assignable to CorrelationId.
    takeCorrelation(cid);
    expect(cid as string).toBe(FIXED_UUID_V4);
  });

  it("a CommandId cannot be assigned where a DomainEventId is required", () => {
    function takeEvent(_id: DomainEventId): void {}

    const cid: CommandId = FIXED_UUID_V4 as CommandId;
    // @ts-expect-error: CommandId is not assignable to DomainEventId.
    takeEvent(cid);
    expect(cid as string).toBe(FIXED_UUID_V4);
  });

  it("a CorrelationId cannot be assigned where a DomainEventId is required", () => {
    function takeEvent(_id: DomainEventId): void {}

    const cor: CorrelationId = FIXED_UUID_V4 as CorrelationId;
    // @ts-expect-error: CorrelationId is not assignable to DomainEventId.
    takeEvent(cor);
    expect(cor as string).toBe(FIXED_UUID_V4);
  });
});

// ---------------------------------------------------------------------------
// EventSequence
// ---------------------------------------------------------------------------

describe("EventSequence", () => {
  it("accepts a positive safe integer", () => {
    expect(eventSequenceSchema.parse(1)).toBe(1);
    expect(eventSequenceSchema.parse(42)).toBe(42);
    expect(eventSequenceSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects zero", () => {
    expect(() => eventSequenceSchema.parse(0)).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => eventSequenceSchema.parse(-1)).toThrow();
    expect(() => eventSequenceSchema.parse(-1000)).toThrow();
  });

  it("rejects fractional values", () => {
    expect(() => eventSequenceSchema.parse(1.5)).toThrow();
    expect(() => eventSequenceSchema.parse(0.1)).toThrow();
  });

  it("rejects unsafe integers", () => {
    expect(() =>
      eventSequenceSchema.parse(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
    expect(() =>
      eventSequenceSchema.parse(Number.MIN_SAFE_INTEGER - 1),
    ).toThrow();
  });

  it("rejects strings", () => {
    expect(() => eventSequenceSchema.parse("1")).toThrow();
    expect(() => eventSequenceSchema.parse("42")).toThrow();
  });

  it("rejects objects", () => {
    expect(() => eventSequenceSchema.parse({ value: 1 })).toThrow();
    expect(() => eventSequenceSchema.parse({})).toThrow();
  });

  it("rejects malformed values", () => {
    expect(() => eventSequenceSchema.parse(true)).toThrow();
    expect(() => eventSequenceSchema.parse(null)).toThrow();
    expect(() => eventSequenceSchema.parse(undefined)).toThrow();
    expect(() => eventSequenceSchema.parse(NaN)).toThrow();
    expect(() => eventSequenceSchema.parse(Infinity)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandOrigin
// ---------------------------------------------------------------------------

// Independent, spec-backed expected list of CommandOrigin literals.
// Written directly from Event Contracts Section 2.1 — NOT derived from
// the COMMAND_ORIGINS implementation array being tested.
const EXPECTED_COMMAND_ORIGINS = [
  "PATIENT_UI",
  "INQUIRY_PROCESSING",
  "SAFETY_ROUTER",
  "LEARNING_ENGINE",
  "PATTERN_ENGINE",
  "CARE_PREPARATION",
  "SYSTEM_TIMER",
  "IMPORT_OR_RESTORE",
] as const;

describe("CommandOrigin", () => {
  it("COMMAND_ORIGINS catalogue equals the exact spec list in order", () => {
    expect([...COMMAND_ORIGINS]).toEqual([...EXPECTED_COMMAND_ORIGINS]);
  });

  it("COMMAND_ORIGINS has no duplicates", () => {
    expect(new Set(COMMAND_ORIGINS).size).toBe(COMMAND_ORIGINS.length);
  });

  it.each(COMMAND_ORIGINS)("accepts %s", (origin) => {
    expect(commandOriginSchema.parse(origin)).toBe(origin);
  });

  it("rejects AI as a command origin", () => {
    expect(() => commandOriginSchema.parse("AI")).toThrow();
  });

  it("rejects AI_MODEL as a command origin", () => {
    expect(() => commandOriginSchema.parse("AI_MODEL")).toThrow();
  });

  it("rejects unknown origins", () => {
    expect(() => commandOriginSchema.parse("UNKNOWN")).toThrow();
    expect(() => commandOriginSchema.parse("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CommandCause
// ---------------------------------------------------------------------------

describe("CommandCause", () => {
  it("accepts DIRECT_PATIENT_ACTION with exact required fields", () => {
    const cause: CommandCause = { kind: "DIRECT_PATIENT_ACTION" };
    expect(commandCauseSchema.parse(cause)).toEqual(cause);
  });

  it("accepts DOMAIN_EVENT with a valid DomainEventId", () => {
    const cause = { kind: "DOMAIN_EVENT" as const, eventId: FIXED_UUID_V4 };
    expect(commandCauseSchema.parse(cause)).toEqual({
      kind: "DOMAIN_EVENT",
      eventId: FIXED_UUID_V4,
    });
  });

  it("accepts SCHEDULED_RULE with ruleKey and dueAt", () => {
    const cause = {
      kind: "SCHEDULED_RULE" as const,
      ruleKey: "expire-inquiries",
      dueAt: VALID_INSTANT,
    };
    expect(commandCauseSchema.parse(cause)).toEqual(cause);
  });

  it("accepts RECOVERY with a valid previousCommandId", () => {
    const cause = {
      kind: "RECOVERY" as const,
      previousCommandId: FIXED_UUID_V4,
    };
    expect(commandCauseSchema.parse(cause)).toEqual(cause);
  });

  it("accepts IMPORT_OR_RESTORE with batchId", () => {
    const cause = {
      kind: "IMPORT_OR_RESTORE" as const,
      batchId: "batch-001",
    };
    expect(commandCauseSchema.parse(cause)).toEqual(cause);
  });

  it("rejects DOMAIN_EVENT with a malformed identifier", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "DOMAIN_EVENT",
        eventId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("rejects SCHEDULED_RULE with an invalid instant", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "SCHEDULED_RULE",
        ruleKey: "rule",
        dueAt: INVALID_INSTANT,
      }),
    ).toThrow();
  });

  it("rejects RECOVERY with a malformed identifier", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "RECOVERY",
        previousCommandId: "bad",
      }),
    ).toThrow();
  });

  it("rejects DIRECT_PATIENT_ACTION with a missing kind field", () => {
    expect(() => commandCauseSchema.parse({})).toThrow();
  });

  it("rejects DIRECT_PATIENT_ACTION with extra unknown fields", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "DIRECT_PATIENT_ACTION",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects DOMAIN_EVENT with an extra unknown field", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "DOMAIN_EVENT",
        eventId: FIXED_UUID_V4,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects SCHEDULED_RULE with an extra unknown field", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "SCHEDULED_RULE",
        ruleKey: "rule",
        dueAt: VALID_INSTANT,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects RECOVERY with an extra unknown field", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "RECOVERY",
        previousCommandId: FIXED_UUID_V4,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects IMPORT_OR_RESTORE with an extra unknown field", () => {
    expect(() =>
      commandCauseSchema.parse({
        kind: "IMPORT_OR_RESTORE",
        batchId: "batch",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects DOMAIN_EVENT missing the eventId field", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "DOMAIN_EVENT" }),
    ).toThrow();
  });

  it("rejects SCHEDULED_RULE missing the ruleKey field", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "SCHEDULED_RULE", dueAt: VALID_INSTANT }),
    ).toThrow();
  });

  it("rejects SCHEDULED_RULE missing the dueAt field", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "SCHEDULED_RULE", ruleKey: "rule" }),
    ).toThrow();
  });

  it("rejects RECOVERY missing the previousCommandId field", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "RECOVERY" }),
    ).toThrow();
  });

  it("rejects IMPORT_OR_RESTORE missing the batchId field", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "IMPORT_OR_RESTORE" }),
    ).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      commandCauseSchema.parse({ kind: "UNKNOWN_KIND" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Public barrel — exposes only approved Packet 4A contracts
// ---------------------------------------------------------------------------

describe("public barrel", () => {
  const APPROVED_EXPORTS = new Set([
    // Task 1 identifiers
    "commandIdSchema",
    "correlationIdSchema",
    "domainEventIdSchema",
    "eventSequenceSchema",
    "createCommandId",
    "createCorrelationId",
    "createDomainEventId",
    "COMMAND_ORIGINS",
    "commandOriginSchema",
    "commandCauseSchema",
    // Task 2 command names
    "patientSettingsCommandNameSchema",
    "carePlanCommandNameSchema",
    "healthRecordCommandNameSchema",
    "patientControlCommandNameSchema",
    "learningPatternCommandNameSchema",
    "inquiryCommandNameSchema",
    "safetyCommandNameSchema",
    "carePreparationCommandNameSchema",
    "commandNameSchema",
    // Task 2 event names
    "patientSettingsEventNameSchema",
    "carePlanEventNameSchema",
    "healthRecordEventNameSchema",
    "learningEventNameSchema",
    "patternEventNameSchema",
    "inquiryEventNameSchema",
    "safetyEventNameSchema",
    "carePreparationEventNameSchema",
    "domainEventNameSchema",
    // Task 3 command envelope
    "recordHeadExpectationSchema",
    "createCommandEnvelopeSchema",
  ]);

  it("exports every approved contract", () => {
    for (const name of APPROVED_EXPORTS) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it("exports no unapproved contract", () => {
    const exportedKeys = Object.keys(barrel);
    const unexpected = exportedKeys.filter(
      (key) => !APPROVED_EXPORTS.has(key),
    );
    expect(unexpected).toEqual([]);
  });
});
