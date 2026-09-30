import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CONSUMER_KEYS,
  consumerKeySchema,
  WORK_PRIORITIES,
  workPrioritySchema,
  WORK_ERROR_CODES,
  workErrorCodeSchema,
  WORK_OBSOLETE_REASON_CODES,
  workObsoleteReasonCodeSchema,
  workItemIdSchema,
  createWorkItemId,
  eventWorkStateSchema,
  eventWorkItemSchema,
  type EventWorkItem,
  type WorkItemId,
} from "./event-work";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_2 = "a1b2c3d4-e5f6-4789-9abc-def012345678";
const UUID_3 = "b2c3d4e5-f6a7-489a-9bcd-ef0123456789";
const VALID_INSTANT = "2026-09-28T10:00:00Z";

// ---------------------------------------------------------------------------
// Independent, spec-backed expected catalogues
// Written directly from Event Contracts Section 4.1 — NOT derived from the
// implementation arrays being tested.
// ---------------------------------------------------------------------------

const EXPECTED_CONSUMER_KEYS = [
  "SAFETY_PRESENTATION_RECOVERY",
  "DEPENDENCY_INVALIDATION",
  "REMINDER_RECONCILIATION",
  "LEARNING_REEVALUATION",
  "PATTERN_REEVALUATION",
  "INQUIRY_ELIGIBILITY",
  "CARE_SUMMARY_INVALIDATION",
  "CURRENT_STATE_PROJECTION",
  "MAINTENANCE",
] as const;

const EXPECTED_WORK_PRIORITIES = [
  "SAFETY_RECOVERY",
  "DEPENDENCY_INVALIDATION",
  "PATIENT_VISIBLE_CURRENT_STATE",
  "ORDINARY_INTELLIGENCE",
  "MAINTENANCE",
] as const;

const EXPECTED_WORK_OBSOLETE_REASON_CODES = [
  "SOURCE_DELETED",
  "SOURCE_SUPERSEDED",
  "SOURCE_NO_LONGER_ELIGIBLE",
] as const;

const EXPECTED_WORK_ERROR_CODES = [
  "SOURCE_NO_LONGER_CURRENT",
  "SOURCE_REVISION_UNAVAILABLE",
  "UNSUPPORTED_EVENT_VERSION",
  "HANDLER_CONFIGURATION_INVALID",
  "TRANSIENT_STORAGE_ERROR",
  "RUNTIME_INTERRUPTED",
  "EFFECT_COMMAND_REJECTED",
  "CYCLE_GUARD_TRIGGERED",
  "INTEGRITY_CHECK_FAILED",
] as const;

// ---------------------------------------------------------------------------
// Catalogue tests
// ---------------------------------------------------------------------------

describe("CONSUMER_KEYS catalogue", () => {
  it("matches the exact spec list in order", () => {
    expect([...CONSUMER_KEYS]).toEqual([...EXPECTED_CONSUMER_KEYS]);
  });

  it("has no duplicates", () => {
    expect(new Set(CONSUMER_KEYS).size).toBe(CONSUMER_KEYS.length);
  });

  it.each(CONSUMER_KEYS)("accepts %s", (key) => {
    expect(consumerKeySchema.parse(key)).toBe(key);
  });

  it("rejects AI as a consumer", () => {
    expect(() => consumerKeySchema.parse("AI")).toThrow();
  });

  it("rejects SAFETY_CLASSIFICATION as a consumer", () => {
    expect(() => consumerKeySchema.parse("SAFETY_CLASSIFICATION")).toThrow();
  });

  it("rejects unknown consumers", () => {
    expect(() => consumerKeySchema.parse("UNKNOWN")).toThrow();
    expect(() => consumerKeySchema.parse("")).toThrow();
  });
});

describe("WORK_PRIORITIES catalogue", () => {
  it("matches the exact spec list in order", () => {
    expect([...WORK_PRIORITIES]).toEqual([...EXPECTED_WORK_PRIORITIES]);
  });

  it("has no duplicates", () => {
    expect(new Set(WORK_PRIORITIES).size).toBe(WORK_PRIORITIES.length);
  });

  it.each(WORK_PRIORITIES)("accepts %s", (p) => {
    expect(workPrioritySchema.parse(p)).toBe(p);
  });

  it("rejects unknown priorities", () => {
    expect(() => workPrioritySchema.parse("UNKNOWN")).toThrow();
  });
});

describe("WORK_ERROR_CODES catalogue", () => {
  it("matches the exact spec list in order", () => {
    expect([...WORK_ERROR_CODES]).toEqual([...EXPECTED_WORK_ERROR_CODES]);
  });

  it("has no duplicates", () => {
    expect(new Set(WORK_ERROR_CODES).size).toBe(WORK_ERROR_CODES.length);
  });

  it.each(WORK_ERROR_CODES)("accepts %s", (code) => {
    expect(workErrorCodeSchema.parse(code)).toBe(code);
  });

  it("rejects unknown error codes", () => {
    expect(() => workErrorCodeSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("WORK_OBSOLETE_REASON_CODES catalogue", () => {
  it("matches the exact spec list in order", () => {
    expect([...WORK_OBSOLETE_REASON_CODES]).toEqual([
      ...EXPECTED_WORK_OBSOLETE_REASON_CODES,
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(WORK_OBSOLETE_REASON_CODES).size).toBe(
      WORK_OBSOLETE_REASON_CODES.length,
    );
  });

  it.each(WORK_OBSOLETE_REASON_CODES)("accepts %s", (code) => {
    expect(workObsoleteReasonCodeSchema.parse(code)).toBe(code);
  });

  it("rejects unknown obsolete reasons", () => {
    expect(() => workObsoleteReasonCodeSchema.parse("UNKNOWN")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WorkItemId
// ---------------------------------------------------------------------------

describe("WorkItemId", () => {
  it("createWorkItemId returns a value accepted by the schema", () => {
    const id = createWorkItemId();
    expect(workItemIdSchema.parse(id)).toBe(id);
  });

  it("createWorkItemId produces unique values", () => {
    expect(createWorkItemId()).not.toBe(createWorkItemId());
  });

  it("accepts a valid UUID v4", () => {
    expect(workItemIdSchema.parse(UUID)).toBe(UUID);
  });

  it("rejects a non-v4 UUID", () => {
    expect(() => workItemIdSchema.parse("f47ac10b-58cc-5372-a567-0e02b2c3d479")).toThrow();
  });

  it("rejects a malformed string", () => {
    expect(() => workItemIdSchema.parse("not-a-uuid")).toThrow();
  });

  it("brand is distinct from WorkItemId at compile time", () => {
    function takeWorkItem(_id: WorkItemId): void {}
    const plain = UUID as string;
    // @ts-expect-error: plain string is not assignable to WorkItemId.
    takeWorkItem(plain);
    expect(plain).toBe(UUID);
  });
});

// ---------------------------------------------------------------------------
// EventWorkState
// ---------------------------------------------------------------------------

describe("eventWorkStateSchema", () => {
  it("accepts PENDING", () => {
    expect(eventWorkStateSchema.parse({ state: "PENDING" })).toEqual({
      state: "PENDING",
    });
  });

  it("rejects PENDING with unknown fields", () => {
    expect(() =>
      eventWorkStateSchema.parse({ state: "PENDING", extra: true }),
    ).toThrow();
  });

  it("accepts CLAIMED", () => {
    const state = {
      state: "CLAIMED",
      leaseToken: "token-1",
      claimedByInstance: "instance-1",
      leaseExpiresAt: VALID_INSTANT,
    };
    expect(eventWorkStateSchema.parse(state)).toEqual(state);
  });

  it("rejects CLAIMED with empty leaseToken", () => {
    expect(() =>
      eventWorkStateSchema.parse({
        state: "CLAIMED",
        leaseToken: "",
        claimedByInstance: "instance-1",
        leaseExpiresAt: VALID_INSTANT,
      }),
    ).toThrow();
  });

  it("rejects CLAIMED with empty claimedByInstance", () => {
    expect(() =>
      eventWorkStateSchema.parse({
        state: "CLAIMED",
        leaseToken: "token-1",
        claimedByInstance: "",
        leaseExpiresAt: VALID_INSTANT,
      }),
    ).toThrow();
  });

  it("rejects CLAIMED with invalid leaseExpiresAt", () => {
    expect(() =>
      eventWorkStateSchema.parse({
        state: "CLAIMED",
        leaseToken: "token-1",
        claimedByInstance: "instance-1",
        leaseExpiresAt: "bad",
      }),
    ).toThrow();
  });

  it("accepts RETRY_WAIT", () => {
    const state = {
      state: "RETRY_WAIT",
      availableAt: VALID_INSTANT,
      errorCode: "TRANSIENT_STORAGE_ERROR",
    };
    expect(eventWorkStateSchema.parse(state)).toEqual(state);
  });

  it("accepts COMPLETED", () => {
    const state = { state: "COMPLETED", completedAt: VALID_INSTANT };
    expect(eventWorkStateSchema.parse(state)).toEqual(state);
  });

  it("accepts TERMINAL_FAILURE", () => {
    const state = {
      state: "TERMINAL_FAILURE",
      failedAt: VALID_INSTANT,
      errorCode: "INTEGRITY_CHECK_FAILED",
    };
    expect(eventWorkStateSchema.parse(state)).toEqual(state);
  });

  it("accepts CANCELLED_OBSOLETE", () => {
    const state = {
      state: "CANCELLED_OBSOLETE",
      cancelledAt: VALID_INSTANT,
      reasonCode: "SOURCE_SUPERSEDED",
    };
    expect(eventWorkStateSchema.parse(state)).toEqual(state);
  });

  it("rejects unknown state", () => {
    expect(() => eventWorkStateSchema.parse({ state: "UNKNOWN" })).toThrow();
  });

  it("rejects cross-state fields on PENDING", () => {
    expect(() =>
      eventWorkStateSchema.parse({
        state: "PENDING",
        completedAt: VALID_INSTANT,
      }),
    ).toThrow();
  });

  it("rejects cross-state fields on COMPLETED", () => {
    expect(() =>
      eventWorkStateSchema.parse({
        state: "COMPLETED",
        completedAt: VALID_INSTANT,
        errorCode: "TRANSIENT_STORAGE_ERROR",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EventWorkItem
// ---------------------------------------------------------------------------

function buildValidWorkItemInput(): Record<string, unknown> {
  return {
    workItemId: UUID,
    eventId: UUID,
    consumer: "LEARNING_REEVALUATION",
    handlerVersion: "1.0.0",
    priority: "ORDINARY_INTELLIGENCE",
    createdAt: VALID_INSTANT,
    attemptCount: 0,
    state: { state: "PENDING" },
    plannedCommands: [],
  };
}

describe("eventWorkItemSchema", () => {
  it("parses a valid work item with PENDING and empty plannedCommands", () => {
    const input = buildValidWorkItemInput();
    expect(eventWorkItemSchema.parse(input)).toEqual(input);
  });

  it("parses a work item with planned commands", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "effect-1", commandId: UUID_2 },
      { effectKey: "effect-2", commandId: UUID_3 },
    ];
    expect(() => eventWorkItemSchema.parse(input)).not.toThrow();
  });

  it("accepts zero attemptCount", () => {
    const input = buildValidWorkItemInput();
    expect(() => eventWorkItemSchema.parse(input)).not.toThrow();
  });

  it("rejects negative attemptCount", () => {
    const input = buildValidWorkItemInput();
    input.attemptCount = -1;
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects fractional attemptCount", () => {
    const input = buildValidWorkItemInput();
    input.attemptCount = 0.5;
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects unsafe-integer attemptCount", () => {
    const input = buildValidWorkItemInput();
    input.attemptCount = Number.MAX_SAFE_INTEGER + 1;
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects empty handlerVersion", () => {
    const input = buildValidWorkItemInput();
    input.handlerVersion = "";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects invalid workItemId", () => {
    const input = buildValidWorkItemInput();
    input.workItemId = "not-a-uuid";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects invalid eventId", () => {
    const input = buildValidWorkItemInput();
    input.eventId = "bad";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects unknown consumer", () => {
    const input = buildValidWorkItemInput();
    input.consumer = "UNKNOWN";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects unknown priority", () => {
    const input = buildValidWorkItemInput();
    input.priority = "UNKNOWN";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects invalid createdAt instant", () => {
    const input = buildValidWorkItemInput();
    input.createdAt = "bad";
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    const input = buildValidWorkItemInput();
    input.extra = true;
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects invalid state", () => {
    const input = buildValidWorkItemInput();
    input.state = { state: "UNKNOWN" };
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Planned command validations
// ---------------------------------------------------------------------------

describe("plannedCommands validation", () => {
  it("rejects duplicate effect keys", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "same", commandId: UUID_2 },
      { effectKey: "same", commandId: UUID_3 },
    ];
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects duplicate command IDs", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "e1", commandId: UUID_2 },
      { effectKey: "e2", commandId: UUID_2 },
    ];
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects empty effectKey", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "", commandId: UUID_2 },
    ];
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects invalid commandId", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "e1", commandId: "not-a-uuid" },
    ];
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });

  it("rejects unknown nested field in planned command", () => {
    const input = buildValidWorkItemInput();
    input.plannedCommands = [
      { effectKey: "e1", commandId: UUID_2, extra: true },
    ];
    expect(() => eventWorkItemSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema inference
// ---------------------------------------------------------------------------

describe("schema inference", () => {
  it("infers EventWorkItem", () => {
    type Inferred = z.infer<typeof eventWorkItemSchema>;
    const _check: Inferred = {} as EventWorkItem;
    expect(_check).toBeDefined();
  });
});
