import { describe, expect, it } from "vitest";
import { StorageRowValidationError } from "./storage-row-codec";
import {
  eventSequenceHighWaterMarkRowCodec,
  eventSequenceHighWaterMarkRowSchema,
} from "./event-sequence-metadata";

const validRow = {
  key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
  lastAllocatedSequence: 0,
  updatedAt: "2026-09-30T12:00:00Z",
} as const;

describe("eventSequenceHighWaterMarkRowSchema", () => {
  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])(
    "accepts and preserves safe high-water value %s",
    (lastAllocatedSequence) => {
      expect(
        eventSequenceHighWaterMarkRowSchema.parse({
          ...validRow,
          lastAllocatedSequence,
        }),
      ).toEqual({ ...validRow, lastAllocatedSequence });
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid high-water value %s",
    (lastAllocatedSequence) => {
      expect(
        eventSequenceHighWaterMarkRowSchema.safeParse({
          ...validRow,
          lastAllocatedSequence,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a storage-metadata key owned by another variant", () => {
    expect(
      eventSequenceHighWaterMarkRowSchema.safeParse({
        ...validRow,
        key: "DATABASE_IDENTITY",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      eventSequenceHighWaterMarkRowSchema.safeParse({
        ...validRow,
        value: 0,
      }).success,
    ).toBe(false);
  });

  it("preserves the exact validated instant", () => {
    expect(eventSequenceHighWaterMarkRowSchema.parse(validRow).updatedAt).toBe(
      "2026-09-30T12:00:00Z",
    );
  });
});

describe("eventSequenceHighWaterMarkRowCodec", () => {
  it("returns the exact row after write validation", () => {
    expect(eventSequenceHighWaterMarkRowCodec.validateForWrite(validRow)).toEqual(
      validRow,
    );
  });

  it("reports malformed proposed rows as write validation failures", () => {
    expect(() =>
      eventSequenceHighWaterMarkRowCodec.validateForWrite({
        ...validRow,
        lastAllocatedSequence: -1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<StorageRowValidationError>>({
        code: "STORAGE_VALIDATION_FAILED",
        table: "storageMetadata",
        boundary: "WRITE",
      }),
    );
  });

  it("reports malformed persisted rows as read integrity failures", () => {
    expect(() =>
      eventSequenceHighWaterMarkRowCodec.validateAfterRead({
        ...validRow,
        extra: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<StorageRowValidationError>>({
        code: "STORAGE_INTEGRITY_FAILED",
        table: "storageMetadata",
        boundary: "READ",
      }),
    );
  });
});
