import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  COMMAND_ERROR_CODES,
  commandErrorCodeSchema,
  commandReceiptSchema,
  type CommandReceipt,
} from "./command-receipt";

// Compile-time assertion: z.infer<typeof commandReceiptSchema> must match
// CommandReceipt. If a mismatch arises, the following line will not compile.
// We use a bidirectional assignability check so that neither widening nor
// narrowing passes silently.
type InferredReceipt = z.infer<typeof commandReceiptSchema>;
const _typeCheckA: InferredReceipt extends CommandReceipt ? true : false = true;
const _typeCheckB: CommandReceipt extends InferredReceipt ? true : false = true;
void _typeCheckA;
void _typeCheckB;

// ---------------------------------------------------------------------------
// Constants for building valid receipt objects
// ---------------------------------------------------------------------------

const UUID_1 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_2 = "a47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_3 = "b47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_4 = "c47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_5 = "d47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_INSTANT = "2026-09-28T10:00:00Z";
const VALID_HASH =
  "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";

function makeTypedRevisionRef() {
  return {
    recordType: "GLUCOSE_READING" as const,
    recordId: UUID_2,
    revisionId: UUID_3,
  };
}

function makeRecordHead() {
  return {
    recordId: UUID_2,
    recordType: "GLUCOSE_READING" as const,
    headRevisionId: UUID_3,
    headRevisionNumber: 1,
    state: "ACTIVE" as const,
    updatedAt: VALID_INSTANT,
  };
}

function makeCommittedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "COMMITTED",
    commandId: UUID_1,
    commandHash: VALID_HASH,
    completedAt: VALID_INSTANT,
    transactionId: UUID_4,
    resultingRevisions: [makeTypedRevisionRef()],
    deletedRecords: [{ recordType: "INQUIRY", recordId: UUID_5 }],
    auditEventIds: [UUID_2],
    domainEventIds: [UUID_3],
    ...overrides,
  };
}

function makeNoChangeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "NO_CHANGE",
    commandId: UUID_1,
    commandHash: VALID_HASH,
    completedAt: VALID_INSTANT,
    existingRevisions: [makeTypedRevisionRef()],
    ...overrides,
  };
}

function makeRejectedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "REJECTED",
    commandId: UUID_1,
    commandHash: VALID_HASH,
    completedAt: VALID_INSTANT,
    errorCode: "VALIDATION_FAILED",
    currentHeads: [makeRecordHead()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CommandErrorCode catalogue
// ---------------------------------------------------------------------------

// Independent expected catalogue derived from the specification (Section 13.2).
const EXPECTED_ERROR_CODES = [
  "INVALID_COMMAND",
  "UNSUPPORTED_COMMAND_VERSION",
  "COMMAND_NOT_ALLOWED",
  "RECORD_NOT_FOUND",
  "HEAD_CONFLICT",
  "COMMAND_REPLAY_MISMATCH",
  "VALIDATION_FAILED",
  "INVALID_STATE_TRANSITION",
  "DEPENDENCY_CHANGED",
  "STALE_PATIENT_CONFIRMATION",
  "GOVERNED_ASSET_UNAVAILABLE",
  "STORAGE_COMMIT_FAILED",
  "INTEGRITY_CHECK_FAILED",
] as const;

describe("CommandErrorCode catalogue", () => {
  it("COMMAND_ERROR_CODES matches the spec list exactly", () => {
    expect([...COMMAND_ERROR_CODES]).toEqual([...EXPECTED_ERROR_CODES]);
  });

  it("COMMAND_ERROR_CODES has no duplicates", () => {
    expect(new Set(COMMAND_ERROR_CODES).size).toBe(COMMAND_ERROR_CODES.length);
  });

  it("commandErrorCodeSchema accepts every code", () => {
    for (const code of EXPECTED_ERROR_CODES) {
      expect(commandErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("commandErrorCodeSchema rejects an unknown code", () => {
    expect(() => commandErrorCodeSchema.parse("UNKNOWN_ERROR")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// COMMITTED receipt
// ---------------------------------------------------------------------------

describe("COMMITTED receipt", () => {
  it("parses a valid receipt", () => {
    const receipt = makeCommittedReceipt();
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("parses a receipt with empty arrays", () => {
    const receipt = makeCommittedReceipt({
      resultingRevisions: [],
      deletedRecords: [],
      auditEventIds: [],
      domainEventIds: [],
    });
    expect(() => commandReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("rejects an invalid commandId", () => {
    expect(() =>
      commandReceiptSchema.parse(makeCommittedReceipt({ commandId: "bad" })),
    ).toThrow();
  });

  it("rejects an invalid commandHash (uppercase)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          commandHash: VALID_HASH.toUpperCase(),
        }),
      ),
    ).toThrow();
  });

  it("rejects an invalid completedAt", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ completedAt: "2026-09-28T10:00:00+08:00" }),
      ),
    ).toThrow();
  });

  it("rejects an invalid transactionId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ transactionId: "not-uuid" }),
      ),
    ).toThrow();
  });

  it("rejects an invalid auditEventId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ auditEventIds: ["bad"] }),
      ),
    ).toThrow();
  });

  it("rejects an invalid domainEventId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ domainEventIds: ["bad"] }),
      ),
    ).toThrow();
  });

  it("rejects a deletedRecord with invalid recordType", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          deletedRecords: [{ recordType: "UNKNOWN", recordId: UUID_5 }],
        }),
      ),
    ).toThrow();
  });

  it("rejects a deletedRecord with invalid recordId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          deletedRecords: [
            { recordType: "INQUIRY", recordId: "bad" },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a resultingRevision with invalid revisionId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          resultingRevisions: [
            {
              recordType: "GLUCOSE_READING",
              recordId: UUID_2,
              revisionId: "bad",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects an unknown field in a resultingRevisions entry", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          resultingRevisions: [
            {
              recordType: "GLUCOSE_READING",
              recordId: UUID_2,
              revisionId: UUID_3,
              extra: 1,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    const receipt = makeCommittedReceipt();
    const { transactionId, ...rest } = receipt;
    void transactionId;
    expect(() => commandReceiptSchema.parse(rest)).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ extra: true }),
      ),
    ).toThrow();
  });

  it("rejects an unknown field in a deletedRecord", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({
          deletedRecords: [
            { recordType: "INQUIRY", recordId: UUID_5, extra: 1 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (errorCode)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ errorCode: "VALIDATION_FAILED" }),
      ),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (existingRevisions)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeCommittedReceipt({ existingRevisions: [] }),
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// NO_CHANGE receipt
// ---------------------------------------------------------------------------

describe("NO_CHANGE receipt", () => {
  it("parses a valid receipt", () => {
    const receipt = makeNoChangeReceipt();
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("parses a receipt with empty existingRevisions", () => {
    const receipt = makeNoChangeReceipt({ existingRevisions: [] });
    expect(() => commandReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("rejects an invalid commandId", () => {
    expect(() =>
      commandReceiptSchema.parse(makeNoChangeReceipt({ commandId: "x" })),
    ).toThrow();
  });

  it("rejects an invalid commandHash (wrong length)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({ commandHash: "abc" }),
      ),
    ).toThrow();
  });

  it("rejects an invalid completedAt", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({ completedAt: "nope" }),
      ),
    ).toThrow();
  });

  it("rejects an existingRevision with invalid recordId", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({
          existingRevisions: [
            { recordType: "GLUCOSE_READING", recordId: "bad", revisionId: UUID_3 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects an unknown field in an existingRevisions entry", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({
          existingRevisions: [
            {
              recordType: "GLUCOSE_READING",
              recordId: UUID_2,
              revisionId: UUID_3,
              extra: 1,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    const receipt = makeNoChangeReceipt();
    const { commandHash, ...rest } = receipt;
    void commandHash;
    expect(() => commandReceiptSchema.parse(rest)).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      commandReceiptSchema.parse(makeNoChangeReceipt({ extra: 1 })),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (transactionId)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({ transactionId: UUID_4 }),
      ),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (errorCode)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeNoChangeReceipt({ errorCode: "HEAD_CONFLICT" }),
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// REJECTED receipt
// ---------------------------------------------------------------------------

describe("REJECTED receipt", () => {
  it("parses a valid receipt", () => {
    const receipt = makeRejectedReceipt();
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("parses a receipt with empty currentHeads", () => {
    const receipt = makeRejectedReceipt({ currentHeads: [] });
    expect(() => commandReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("rejects an invalid errorCode", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({ errorCode: "NOT_A_CODE" }),
      ),
    ).toThrow();
  });

  it("rejects an invalid commandId", () => {
    expect(() =>
      commandReceiptSchema.parse(makeRejectedReceipt({ commandId: "" })),
    ).toThrow();
  });

  it("rejects an invalid commandHash (non-hex)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({
          commandHash: "z".repeat(64),
        }),
      ),
    ).toThrow();
  });

  it("rejects an invalid completedAt", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({ completedAt: "bad" }),
      ),
    ).toThrow();
  });

  it("rejects a currentHead with invalid headRevisionNumber", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({
          currentHeads: [
            {
              ...makeRecordHead(),
              headRevisionNumber: 0,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a currentHead with invalid state", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({
          currentHeads: [
            {
              ...makeRecordHead(),
              state: "UNKNOWN",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    const receipt = makeRejectedReceipt();
    const { errorCode, ...rest } = receipt;
    void errorCode;
    expect(() => commandReceiptSchema.parse(rest)).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      commandReceiptSchema.parse(makeRejectedReceipt({ extra: true })),
    ).toThrow();
  });

  it("rejects an unknown field in a currentHead", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({
          currentHeads: [
            { ...makeRecordHead(), extra: 1 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (transactionId)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({ transactionId: UUID_4 }),
      ),
    ).toThrow();
  });

  it("rejects a field belonging to another variant (resultingRevisions)", () => {
    expect(() =>
      commandReceiptSchema.parse(
        makeRejectedReceipt({ resultingRevisions: [] }),
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Opaque reference preservation
// ---------------------------------------------------------------------------

describe("opaque reference preservation", () => {
  it("preserves supplied commandId value without resolution", () => {
    const receipt = makeCommittedReceipt();
    const parsed = commandReceiptSchema.parse(receipt);
    expect(parsed.commandId).toBe(UUID_1);
  });

  it("preserves supplied transactionId value without resolution", () => {
    const receipt = makeCommittedReceipt();
    const parsed = commandReceiptSchema.parse(receipt);
    expect(parsed.outcome).toBe("COMMITTED");
    if (parsed.outcome === "COMMITTED") {
      expect(parsed.transactionId).toBe(UUID_4);
    }
  });

  it("preserves supplied auditEventIds without resolution", () => {
    const receipt = makeCommittedReceipt();
    const parsed = commandReceiptSchema.parse(receipt);
    expect(parsed.outcome).toBe("COMMITTED");
    if (parsed.outcome === "COMMITTED") {
      expect(parsed.auditEventIds).toEqual([UUID_2]);
    }
  });

  it("preserves supplied domainEventIds without resolution", () => {
    const receipt = makeCommittedReceipt();
    const parsed = commandReceiptSchema.parse(receipt);
    expect(parsed.outcome).toBe("COMMITTED");
    if (parsed.outcome === "COMMITTED") {
      expect(parsed.domainEventIds).toEqual([UUID_3]);
    }
  });
});
