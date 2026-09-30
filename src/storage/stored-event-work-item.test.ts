import { describe, it, expect } from "vitest";
import {
  WORK_PRIORITY_RANKS,
  type WorkPriorityRank,
  type StoredEventWorkItem,
  storedEventWorkItemSchema,
  createStoredEventWorkItem,
} from "./stored-event-work-item";
import {
  type EventWorkItem,
  WORK_PRIORITIES,
} from "@/application/contracts/event-work";
import {
  type EventSequence,
  eventSequenceSchema,
} from "@/application/contracts/command-event-identifiers";
import { type Instant, instantSchema } from "@/domain/shared/time";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstant(iso: string): Instant {
  return instantSchema.parse(iso);
}

function makeEventSequence(n: number): EventSequence {
  return eventSequenceSchema.parse(n);
}

// Valid base work item factory — starts from PENDING.
function makeBaseWorkItem(overrides?: Partial<EventWorkItem>): EventWorkItem {
  return {
    workItemId:
      "00000000-0000-4000-8000-000000000001" as EventWorkItem["workItemId"],
    eventId:
      "00000000-0000-4000-8000-000000000002" as EventWorkItem["eventId"],
    consumer: "DEPENDENCY_INVALIDATION",
    handlerVersion: "1.0.0",
    priority: "ORDINARY_INTELLIGENCE",
    createdAt: makeInstant("2026-09-30T10:00:00Z"),
    attemptCount: 0,
    state: { state: "PENDING" },
    plannedCommands: [],
    ...overrides,
  };
}

const SEQ = makeEventSequence(1);

// ---------------------------------------------------------------------------
// WORK_PRIORITY_RANKS — exhaustive, frozen, exact values
// ---------------------------------------------------------------------------

describe("WORK_PRIORITY_RANKS", () => {
  it("contains exactly the five approved priorities", () => {
    expect(Object.keys(WORK_PRIORITY_RANKS).sort()).toEqual([
      "DEPENDENCY_INVALIDATION",
      "MAINTENANCE",
      "ORDINARY_INTELLIGENCE",
      "PATIENT_VISIBLE_CURRENT_STATE",
      "SAFETY_RECOVERY",
    ]);
  });

  it("maps SAFETY_RECOVERY to 0", () => {
    expect(WORK_PRIORITY_RANKS.SAFETY_RECOVERY).toBe(0);
  });

  it("maps DEPENDENCY_INVALIDATION to 1", () => {
    expect(WORK_PRIORITY_RANKS.DEPENDENCY_INVALIDATION).toBe(1);
  });

  it("maps PATIENT_VISIBLE_CURRENT_STATE to 2", () => {
    expect(WORK_PRIORITY_RANKS.PATIENT_VISIBLE_CURRENT_STATE).toBe(2);
  });

  it("maps ORDINARY_INTELLIGENCE to 3", () => {
    expect(WORK_PRIORITY_RANKS.ORDINARY_INTELLIGENCE).toBe(3);
  });

  it("maps MAINTENANCE to 4", () => {
    expect(WORK_PRIORITY_RANKS.MAINTENANCE).toBe(4);
  });

  it("is exhaustive — every WorkPriority has a rank", () => {
    for (const p of WORK_PRIORITIES) {
      expect(p in WORK_PRIORITY_RANKS).toBe(true);
    }
  });

  it("is frozen at runtime", () => {
    expect(Object.isFrozen(WORK_PRIORITY_RANKS)).toBe(true);
  });

  it("has rank values that are exactly 0 | 1 | 2 | 3 | 4", () => {
    const values = Object.values(WORK_PRIORITY_RANKS);
    for (const v of values) {
      expect(typeof v).toBe("number");
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// createStoredEventWorkItem — table-driven factory tests for all six states
// ---------------------------------------------------------------------------

describe("createStoredEventWorkItem", () => {
  // PENDING
  it("derives PENDING: stateCode=PENDING, availableAt=createdAt, no leaseExpiresAt", () => {
    const item = makeBaseWorkItem({ state: { state: "PENDING" } });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("PENDING");
    expect(stored.priorityRank).toBe(
      WORK_PRIORITY_RANKS[item.priority],
    );
    expect(stored.sourceEventSequence).toBe(SEQ);
    expect(stored.availableAt).toBe(item.createdAt);
    expect(stored.leaseExpiresAt).toBeUndefined();
  });

  // CLAIMED
  it("derives CLAIMED: stateCode=CLAIMED, leaseExpiresAt=state.leaseExpiresAt, no availableAt", () => {
    const leaseExpiry = makeInstant("2026-09-30T11:00:00Z");
    const item = makeBaseWorkItem({
      state: {
        state: "CLAIMED",
        leaseToken: "token-abc",
        claimedByInstance: "instance-1",
        leaseExpiresAt: leaseExpiry,
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("CLAIMED");
    expect(stored.leaseExpiresAt).toBe(leaseExpiry);
    expect(stored.availableAt).toBeUndefined();
  });

  // RETRY_WAIT
  it("derives RETRY_WAIT: stateCode=RETRY_WAIT, availableAt=state.availableAt, no leaseExpiresAt", () => {
    const retryAt = makeInstant("2026-09-30T12:00:00Z");
    const item = makeBaseWorkItem({
      state: {
        state: "RETRY_WAIT",
        availableAt: retryAt,
        errorCode: "TRANSIENT_STORAGE_ERROR",
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("RETRY_WAIT");
    expect(stored.availableAt).toBe(retryAt);
    expect(stored.leaseExpiresAt).toBeUndefined();
  });

  // COMPLETED
  it("derives COMPLETED: stateCode=COMPLETED, no availableAt, no leaseExpiresAt", () => {
    const item = makeBaseWorkItem({
      state: { state: "COMPLETED", completedAt: makeInstant("2026-09-30T10:30:00Z") },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("COMPLETED");
    expect(stored.availableAt).toBeUndefined();
    expect(stored.leaseExpiresAt).toBeUndefined();
  });

  // TERMINAL_FAILURE
  it("derives TERMINAL_FAILURE: stateCode=TERMINAL_FAILURE, no availableAt, no leaseExpiresAt", () => {
    const item = makeBaseWorkItem({
      state: {
        state: "TERMINAL_FAILURE",
        failedAt: makeInstant("2026-09-30T10:30:00Z"),
        errorCode: "INTEGRITY_CHECK_FAILED",
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("TERMINAL_FAILURE");
    expect(stored.availableAt).toBeUndefined();
    expect(stored.leaseExpiresAt).toBeUndefined();
  });

  // CANCELLED_OBSOLETE
  it("derives CANCELLED_OBSOLETE: stateCode=CANCELLED_OBSOLETE, no availableAt, no leaseExpiresAt", () => {
    const item = makeBaseWorkItem({
      state: {
        state: "CANCELLED_OBSOLETE",
        cancelledAt: makeInstant("2026-09-30T10:30:00Z"),
        reasonCode: "SOURCE_DELETED",
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(stored.stateCode).toBe("CANCELLED_OBSOLETE");
    expect(stored.availableAt).toBeUndefined();
    expect(stored.leaseExpiresAt).toBeUndefined();
  });

  // Priority rank for each priority
  it("derives correct priorityRank for SAFETY_RECOVERY (0)", () => {
    const item = makeBaseWorkItem({ priority: "SAFETY_RECOVERY" });
    expect(createStoredEventWorkItem(item, SEQ).priorityRank).toBe(0);
  });

  it("derives correct priorityRank for DEPENDENCY_INVALIDATION (1)", () => {
    const item = makeBaseWorkItem({ priority: "DEPENDENCY_INVALIDATION" });
    expect(createStoredEventWorkItem(item, SEQ).priorityRank).toBe(1);
  });

  it("derives correct priorityRank for PATIENT_VISIBLE_CURRENT_STATE (2)", () => {
    const item = makeBaseWorkItem({ priority: "PATIENT_VISIBLE_CURRENT_STATE" });
    expect(createStoredEventWorkItem(item, SEQ).priorityRank).toBe(2);
  });

  it("derives correct priorityRank for ORDINARY_INTELLIGENCE (3)", () => {
    const item = makeBaseWorkItem({ priority: "ORDINARY_INTELLIGENCE" });
    expect(createStoredEventWorkItem(item, SEQ).priorityRank).toBe(3);
  });

  it("derives correct priorityRank for MAINTENANCE (4)", () => {
    const item = makeBaseWorkItem({ priority: "MAINTENANCE" });
    expect(createStoredEventWorkItem(item, SEQ).priorityRank).toBe(4);
  });

  // Round-trip
  it("produces a row that round-trips through storedEventWorkItemSchema", () => {
    const item = makeBaseWorkItem();
    const stored = createStoredEventWorkItem(item, SEQ);
    const parsed = storedEventWorkItemSchema.parse(stored);
    expect(parsed).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------
// storedEventWorkItemSchema — parse rejection for tampered derivatives
// ---------------------------------------------------------------------------

describe("storedEventWorkItemSchema rejection: tampered derivatives", () => {
  function makeStoredPending(): StoredEventWorkItem {
    return createStoredEventWorkItem(
      makeBaseWorkItem({ state: { state: "PENDING" } }),
      SEQ,
    );
  }

  it("rejects wrong stateCode (mismatch with state.state)", () => {
    const row = { ...makeStoredPending(), stateCode: "CLAIMED" as const };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects wrong priorityRank (mismatch with priority)", () => {
    const row = { ...makeStoredPending(), priorityRank: 0 as WorkPriorityRank };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects wrong PENDING availableAt (not equal to createdAt)", () => {
    const row = {
      ...makeStoredPending(),
      availableAt: makeInstant("2026-09-30T20:00:00Z"),
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects wrong RETRY_WAIT availableAt (not equal to state.availableAt)", () => {
    const item = makeBaseWorkItem({
      state: {
        state: "RETRY_WAIT",
        availableAt: makeInstant("2026-09-30T12:00:00Z"),
        errorCode: "TRANSIENT_STORAGE_ERROR",
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    const row = {
      ...stored,
      availableAt: makeInstant("2026-09-30T15:00:00Z"),
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects extra availability on COMPLETED (should be absent)", () => {
    const item = makeBaseWorkItem({
      state: { state: "COMPLETED", completedAt: makeInstant("2026-09-30T10:30:00Z") },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    const row = {
      ...stored,
      availableAt: makeInstant("2026-09-30T10:00:00Z"),
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects missing availability on PENDING (should be present)", () => {
    const stored = makeStoredPending();
    const { availableAt: _omit, ...row } = stored;
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects extra leaseExpiresAt on PENDING (should be absent)", () => {
    const stored = makeStoredPending();
    const row = {
      ...stored,
      leaseExpiresAt: makeInstant("2026-09-30T11:00:00Z"),
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects missing leaseExpiresAt on CLAIMED (should be present)", () => {
    const item = makeBaseWorkItem({
      state: {
        state: "CLAIMED",
        leaseToken: "token-abc",
        claimedByInstance: "instance-1",
        leaseExpiresAt: makeInstant("2026-09-30T11:00:00Z"),
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    const { leaseExpiresAt: _omit, ...row } = stored;
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects mismatched leaseExpiresAt on CLAIMED", () => {
    const item = makeBaseWorkItem({
      state: {
        state: "CLAIMED",
        leaseToken: "token-abc",
        claimedByInstance: "instance-1",
        leaseExpiresAt: makeInstant("2026-09-30T11:00:00Z"),
      },
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    const row = {
      ...stored,
      leaseExpiresAt: makeInstant("2026-09-30T12:00:00Z"),
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storedEventWorkItemSchema — rejection for invalid sourceEventSequence
// ---------------------------------------------------------------------------

describe("storedEventWorkItemSchema rejection: sourceEventSequence", () => {
  it("rejects zero sourceEventSequence", () => {
    const row = { ...createStoredEventWorkItem(makeBaseWorkItem(), SEQ), sourceEventSequence: 0 as EventSequence };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects negative sourceEventSequence", () => {
    const row = { ...createStoredEventWorkItem(makeBaseWorkItem(), SEQ), sourceEventSequence: -1 as EventSequence };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects fractional sourceEventSequence", () => {
    const row = { ...createStoredEventWorkItem(makeBaseWorkItem(), SEQ), sourceEventSequence: 1.5 as EventSequence };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects unsafe (non-safe-integer) sourceEventSequence", () => {
    const row = { ...createStoredEventWorkItem(makeBaseWorkItem(), SEQ), sourceEventSequence: (Number.MAX_SAFE_INTEGER + 2) as EventSequence };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storedEventWorkItemSchema — rejection for malformed base work item
// ---------------------------------------------------------------------------

describe("storedEventWorkItemSchema rejection: malformed base", () => {
  it("rejects a malformed base work item (bad workItemId)", () => {
    const stored = createStoredEventWorkItem(makeBaseWorkItem(), SEQ);
    const row = { ...stored, workItemId: "not-a-uuid" };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects a malformed base work item (bad eventId)", () => {
    const stored = createStoredEventWorkItem(makeBaseWorkItem(), SEQ);
    const row = { ...stored, eventId: "not-a-uuid" };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects duplicate planned command effect keys", () => {
    const cmdId1 =
      "00000000-0000-4000-8000-000000000010" as EventWorkItem["plannedCommands"][number]["commandId"];
    const cmdId2 =
      "00000000-0000-4000-8000-000000000011" as EventWorkItem["plannedCommands"][number]["commandId"];
    const item = makeBaseWorkItem({
      plannedCommands: [
        { effectKey: "effect-A", commandId: cmdId1 },
        { effectKey: "effect-A", commandId: cmdId2 },
      ],
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(() => storedEventWorkItemSchema.parse(stored)).toThrow();
  });

  it("rejects duplicate planned command IDs", () => {
    const cmdId =
      "00000000-0000-4000-8000-000000000010" as EventWorkItem["plannedCommands"][number]["commandId"];
    const item = makeBaseWorkItem({
      plannedCommands: [
        { effectKey: "effect-A", commandId: cmdId },
        { effectKey: "effect-B", commandId: cmdId },
      ],
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    expect(() => storedEventWorkItemSchema.parse(stored)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storedEventWorkItemSchema — rejection for unknown fields
// ---------------------------------------------------------------------------

describe("storedEventWorkItemSchema rejection: unknown fields", () => {
  it("rejects an unknown top-level field", () => {
    const stored = createStoredEventWorkItem(makeBaseWorkItem(), SEQ);
    const row = { ...stored, extraField: "no" };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects an unknown nested field in state", () => {
    const item = makeBaseWorkItem({ state: { state: "PENDING" } });
    const stored = createStoredEventWorkItem(item, SEQ);
    const row = {
      ...stored,
      state: { state: "PENDING", bogus: true },
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });

  it("rejects an unknown nested field in plannedCommands entries", () => {
    const cmdId =
      "00000000-0000-4000-8000-000000000010" as EventWorkItem["plannedCommands"][number]["commandId"];
    const item = makeBaseWorkItem({
      plannedCommands: [{ effectKey: "effect-A", commandId: cmdId }],
    });
    const stored = createStoredEventWorkItem(item, SEQ);
    const row = {
      ...stored,
      plannedCommands: [{ effectKey: "effect-A", commandId: cmdId, extra: true }],
    };
    expect(() => storedEventWorkItemSchema.parse(row)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Compile-time type contract
// ---------------------------------------------------------------------------

describe("StoredEventWorkItem type contract", () => {
  it("embeds all EventWorkItem fields plus scheduling derivatives", () => {
    const stored = createStoredEventWorkItem(makeBaseWorkItem(), SEQ);
    // Base fields
    expect(stored.workItemId).toBeDefined();
    expect(stored.eventId).toBeDefined();
    expect(stored.consumer).toBeDefined();
    expect(stored.handlerVersion).toBeDefined();
    expect(stored.priority).toBeDefined();
    expect(stored.createdAt).toBeDefined();
    expect(stored.attemptCount).toBeDefined();
    expect(stored.state).toBeDefined();
    expect(stored.plannedCommands).toBeDefined();
    // Scheduling derivatives
    expect(stored.stateCode).toBeDefined();
    expect(stored.priorityRank).toBeDefined();
    expect(stored.sourceEventSequence).toBeDefined();
  });
});
