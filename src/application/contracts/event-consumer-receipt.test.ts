import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  eventConsumerReceiptSchema,
  type EventConsumerReceipt,
} from "./event-consumer-receipt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_2 = "a1b2c3d4-e5f6-4789-9abc-def012345678";
const UUID_3 = "b2c3d4e5-f6a7-489a-9bcd-ef0123456789";
const VALID_INSTANT = "2026-09-28T10:00:00Z";

function buildReceiptBase() {
  return {
    eventId: UUID,
    consumer: "LEARNING_REEVALUATION",
    handlerVersion: "1.0.0",
    completedAt: VALID_INSTANT,
  };
}

// ---------------------------------------------------------------------------
// NO_ACTION_REQUIRED
// ---------------------------------------------------------------------------

describe("eventConsumerReceiptSchema — NO_ACTION_REQUIRED", () => {
  it("parses a valid NO_ACTION_REQUIRED receipt", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
    };
    expect(eventConsumerReceiptSchema.parse(input)).toEqual(input);
  });

  it("rejects NO_ACTION_REQUIRED with extra fields", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED", reasonCode: "SOURCE_DELETED" },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// COMMANDS_COMMITTED
// ---------------------------------------------------------------------------

describe("eventConsumerReceiptSchema — COMMANDS_COMMITTED", () => {
  it("parses with a single command ID", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: [UUID_2],
      },
    };
    expect(eventConsumerReceiptSchema.parse(input)).toEqual(input);
  });

  it("parses with multiple command IDs", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: [UUID_2, UUID_3],
      },
    };
    expect(eventConsumerReceiptSchema.parse(input)).toEqual(input);
  });

  it("rejects zero command IDs", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: [],
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects duplicate command IDs", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: [UUID_2, UUID_2],
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects invalid commandId", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: ["not-a-uuid"],
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SOURCE_NO_LONGER_ELIGIBLE
// ---------------------------------------------------------------------------

describe("eventConsumerReceiptSchema — SOURCE_NO_LONGER_ELIGIBLE", () => {
  it("parses with a valid reasonCode", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "SOURCE_NO_LONGER_ELIGIBLE",
        reasonCode: "SOURCE_SUPERSEDED",
      },
    };
    expect(eventConsumerReceiptSchema.parse(input)).toEqual(input);
  });

  it("rejects an invalid reasonCode", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "SOURCE_NO_LONGER_ELIGIBLE",
        reasonCode: "UNKNOWN_REASON",
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Field-level rejections
// ---------------------------------------------------------------------------

describe("eventConsumerReceiptSchema — field rejections", () => {
  it("rejects invalid eventId", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
    };
    input.eventId = "bad";
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects invalid consumer", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
    };
    input.consumer = "UNKNOWN";
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects empty handlerVersion", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
    };
    input.handlerVersion = "";
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects invalid completedAt", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
    };
    input.completedAt = "bad";
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects unknown top-level field", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: { kind: "NO_ACTION_REQUIRED" },
      extra: true,
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects fields from COMMANDS_COMMITTED in a NO_ACTION_REQUIRED receipt", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "NO_ACTION_REQUIRED",
        commandIds: [UUID_2],
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });

  it("rejects fields from SOURCE_NO_LONGER_ELIGIBLE in a COMMANDS_COMMITTED receipt", () => {
    const input = {
      ...buildReceiptBase(),
      outcome: {
        kind: "COMMANDS_COMMITTED",
        commandIds: [UUID_2],
        reasonCode: "SOURCE_DELETED",
      },
    };
    expect(() => eventConsumerReceiptSchema.parse(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema inference
// ---------------------------------------------------------------------------

describe("schema inference", () => {
  // Bidirectional compile-time equality:
  // z.infer<typeof eventConsumerReceiptSchema> extends EventConsumerReceipt
  it("inferred schema type extends EventConsumerReceipt", () => {
    type Inferred = z.infer<typeof eventConsumerReceiptSchema>;
    const _check: EventConsumerReceipt = {} as Inferred;
    expect(_check).toBeDefined();
  });

  // EventConsumerReceipt extends z.infer<typeof eventConsumerReceiptSchema>
  it("EventConsumerReceipt extends inferred schema type", () => {
    type Inferred = z.infer<typeof eventConsumerReceiptSchema>;
    const _check: Inferred = {} as EventConsumerReceipt;
    expect(_check).toBeDefined();
  });
});
