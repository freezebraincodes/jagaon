import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  eventRecordChangeSchema,
  createDomainEventEnvelopeSchema,
  type EventRecordChange,
  type DomainEventEnvelope,
} from "./domain-event-envelope";
import {
  patientSettingsEventNameSchema,
  healthRecordEventNameSchema,
  domainEventNameSchema,
  type PatientSettingsEventName,
  type HealthRecordEventName,
  type DomainEventName,
} from "./command-event-names";
import {
  recordIdSchema,
  revisionIdSchema,
  type RecordId,
  type RevisionId,
} from "@/domain/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_INSTANT = "2026-09-28T10:00:00Z";

const RECORD_ID = recordIdSchema.parse(UUID) as RecordId;
const REVISION_ID = revisionIdSchema.parse(UUID) as RevisionId;

const validRevisionCreated: EventRecordChange = {
  kind: "REVISION_CREATED",
  recordType: "GLUCOSE_READING",
  recordId: RECORD_ID,
  action: "CREATE",
  previousRevisionId: null,
  resultingRevisionId: REVISION_ID,
  resultingRevisionNumber: 1,
};

const validRecordDeleted: EventRecordChange = {
  kind: "RECORD_DELETED",
  recordType: "GLUCOSE_READING",
  recordId: RECORD_ID,
  previousRevisionId: REVISION_ID,
  resultingRevisionId: null,
};

// A strict test payload schema — exercises type preservation.
const glucosePayloadSchema = z
  .object({
    reasonCode: z.literal("NEW_READING"),
    governingVersions: z.array(z.string()).min(1),
  })
  .strict();

type GlucosePayload = z.infer<typeof glucosePayloadSchema>;

const validGlucosePayload: GlucosePayload = {
  reasonCode: "NEW_READING",
  governingVersions: ["v1"],
};

function buildValidEnvelopeInput() {
  return {
    envelopeSchemaVersion: 1,
    eventId: UUID,
    eventName: "GLUCOSE_READING_RECORDED" as const,
    eventVersion: 1,
    localSequence: 1,
    transactionIndex: 0,
    transactionId: UUID,
    commandId: UUID,
    correlationId: UUID,
    producedBy: "HEALTH_RECORDS" as const,
    initiator: "PATIENT" as const,
    assistance: "NONE" as const,
    committedAt: VALID_INSTANT,
    change: validRevisionCreated,
    payload: validGlucosePayload,
  };
}

// ---------------------------------------------------------------------------
// EventRecordChange
// ---------------------------------------------------------------------------

describe("eventRecordChangeSchema — REVISION_CREATED", () => {
  it("accepts a valid REVISION_CREATED change", () => {
    expect(eventRecordChangeSchema.parse(validRevisionCreated)).toEqual(
      validRevisionCreated,
    );
  });

  it("accepts a non-null previousRevisionId", () => {
    const change: EventRecordChange = {
      ...validRevisionCreated,
      previousRevisionId: REVISION_ID,
      resultingRevisionNumber: 2,
    };
    expect(eventRecordChangeSchema.parse(change)).toEqual(change);
  });

  it("rejects an unknown field", () => {
    expect(() =>
      eventRecordChangeSchema.parse({ ...validRevisionCreated, extra: true }),
    ).toThrow();
  });

  it("rejects RECORD_DELETED-only fields on REVISION_CREATED", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        kind: "REVISION_CREATED",
        recordType: "GLUCOSE_READING",
        recordId: UUID,
        action: "CREATE",
        previousRevisionId: null,
        resultingRevisionId: UUID,
        resultingRevisionNumber: 1,
        // Cross-variant: RECORD_DELETED requires previousRevisionId non-null
        // and resultingRevisionId null; adding this unknown field must fail.
        cancelledAt: VALID_INSTANT,
      }),
    ).toThrow();
  });

  it("rejects zero for resultingRevisionNumber", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRevisionCreated,
        resultingRevisionNumber: 0,
      }),
    ).toThrow();
  });

  it("rejects negative resultingRevisionNumber", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRevisionCreated,
        resultingRevisionNumber: -1,
      }),
    ).toThrow();
  });

  it("rejects fractional resultingRevisionNumber", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRevisionCreated,
        resultingRevisionNumber: 1.5,
      }),
    ).toThrow();
  });

  it("rejects unsafe-integer resultingRevisionNumber", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRevisionCreated,
        resultingRevisionNumber: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});

describe("eventRecordChangeSchema — RECORD_DELETED", () => {
  it("accepts a valid RECORD_DELETED change", () => {
    expect(eventRecordChangeSchema.parse(validRecordDeleted)).toEqual(
      validRecordDeleted,
    );
  });

  it("rejects an unknown field", () => {
    expect(() =>
      eventRecordChangeSchema.parse({ ...validRecordDeleted, extra: true }),
    ).toThrow();
  });

  it("rejects REVISION_CREATED-only fields on RECORD_DELETED", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        kind: "RECORD_DELETED",
        recordType: "GLUCOSE_READING",
        recordId: UUID,
        previousRevisionId: UUID,
        resultingRevisionId: null,
        action: "CREATE",
      }),
    ).toThrow();
  });

  it("rejects null previousRevisionId on RECORD_DELETED", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRecordDeleted,
        previousRevisionId: null,
      }),
    ).toThrow();
  });

  it("rejects non-null resultingRevisionId on RECORD_DELETED", () => {
    expect(() =>
      eventRecordChangeSchema.parse({
        ...validRecordDeleted,
        resultingRevisionId: UUID,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDomainEventEnvelopeSchema — envelope schema
// ---------------------------------------------------------------------------

const glucoseEnvelopeSchema = createDomainEventEnvelopeSchema(
  healthRecordEventNameSchema,
  glucosePayloadSchema,
);

describe("createDomainEventEnvelopeSchema — valid envelope", () => {
  it("parses a valid typed event envelope", () => {
    const input = buildValidEnvelopeInput();
    const parsed = glucoseEnvelopeSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it("accepts zero transactionIndex", () => {
    const input = buildValidEnvelopeInput();
    expect(glucoseEnvelopeSchema.parse(input)).toEqual(input);
  });

  it("preserves exact event-name type", () => {
    const parsed = glucoseEnvelopeSchema.parse(buildValidEnvelopeInput());
    // eventName must be narrowed to HealthRecordEventName, not the full union.
    const _nameCheck: HealthRecordEventName = parsed.eventName;
    expect(_nameCheck).toBeDefined();
  });

  it("preserves exact payload type", () => {
    const parsed = glucoseEnvelopeSchema.parse(buildValidEnvelopeInput());
    const _payloadCheck: GlucosePayload = parsed.payload;
    expect(_payloadCheck).toBeDefined();
  });
});

describe("createDomainEventEnvelopeSchema — numeric boundaries", () => {
  it("rejects zero for envelopeSchemaVersion", () => {
    const input = buildValidEnvelopeInput();
    input.envelopeSchemaVersion = 0;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects zero for eventVersion", () => {
    const input = buildValidEnvelopeInput();
    input.eventVersion = 0;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects negative envelopeSchemaVersion", () => {
    const input = buildValidEnvelopeInput();
    input.envelopeSchemaVersion = -1;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects fractional eventVersion", () => {
    const input = buildValidEnvelopeInput();
    input.eventVersion = 1.5;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects unsafe-integer envelopeSchemaVersion", () => {
    const input = buildValidEnvelopeInput();
    input.envelopeSchemaVersion = Number.MAX_SAFE_INTEGER + 1;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects negative transactionIndex", () => {
    const input = buildValidEnvelopeInput();
    input.transactionIndex = -1;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects fractional transactionIndex", () => {
    const input = buildValidEnvelopeInput();
    input.transactionIndex = 0.5;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects zero for localSequence", () => {
    const input = buildValidEnvelopeInput();
    input.localSequence = 0;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });
});

describe("createDomainEventEnvelopeSchema — event-name narrowing", () => {
  it("rejects an event name outside the supplied schema", () => {
    const input = buildValidEnvelopeInput();
    // PATIENT_PROFILE_CREATED is a valid DomainEventName but not in the
    // HealthRecordEventName subset supplied to the factory.
    (input as { eventName: string }).eventName = "PATIENT_PROFILE_CREATED";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an arbitrary non-event literal at compile time", () => {
    const schema = createDomainEventEnvelopeSchema(
      patientSettingsEventNameSchema,
      glucosePayloadSchema,
    );
    createDomainEventEnvelopeSchema(
      // @ts-expect-error: "NOT_AN_EVENT" is not a valid DomainEventName.
      z.literal("NOT_AN_EVENT"),
      glucosePayloadSchema,
    );
    expect(schema).toBeDefined();
  });
});

describe("createDomainEventEnvelopeSchema — field-level rejections", () => {
  it("rejects an invalid eventId", () => {
    const input = buildValidEnvelopeInput();
    (input as { eventId: string }).eventId = "not-a-uuid";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid transactionId", () => {
    const input = buildValidEnvelopeInput();
    (input as { transactionId: string }).transactionId = "bad";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid commandId", () => {
    const input = buildValidEnvelopeInput();
    (input as { commandId: string }).commandId = "bad";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid correlationId", () => {
    const input = buildValidEnvelopeInput();
    (input as { correlationId: string }).correlationId = "bad";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid producedBy", () => {
    const input = buildValidEnvelopeInput();
    (input as { producedBy: string }).producedBy = "UNKNOWN_OWNER";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid initiator", () => {
    const input = buildValidEnvelopeInput();
    (input as { initiator: string }).initiator = "ALIEN";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid assistance", () => {
    const input = buildValidEnvelopeInput();
    (input as { assistance: string }).assistance = "MAYBE";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid committedAt timestamp", () => {
    const input = buildValidEnvelopeInput();
    (input as { committedAt: string }).committedAt = "2026-09-28T10:00:00+08:00";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid localSequence", () => {
    const input = buildValidEnvelopeInput();
    input.localSequence = -1 as unknown as typeof input.localSequence;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid change", () => {
    const input = buildValidEnvelopeInput();
    (input as { change: unknown }).change = { kind: "UNKNOWN" };
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an invalid payload", () => {
    const input = buildValidEnvelopeInput();
    (input as { payload: unknown }).payload = { wrong: true };
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    const input = buildValidEnvelopeInput() as unknown as Record<string, unknown>;
    input.extra = true;
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });

  it("rejects unknown fields in a strict payload", () => {
    const input = buildValidEnvelopeInput() as unknown as Record<string, unknown>;
    (input.payload as Record<string, unknown>).unexpected = "fail";
    expect(() => glucoseEnvelopeSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema inference matches DomainEventEnvelope
// ---------------------------------------------------------------------------

describe("schema inference", () => {
  it("infers DomainEventEnvelope<TName, TPayload>", () => {
    type Inferred = z.infer<typeof glucoseEnvelopeSchema>;
    // If inference matches, this assignment compiles.
    const _check: Inferred = {} as DomainEventEnvelope<
      HealthRecordEventName,
      GlucosePayload
    >;
    expect(_check).toBeDefined();
  });
});
