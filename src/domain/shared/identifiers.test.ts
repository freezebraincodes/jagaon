import { describe, it, expect } from "vitest";
import {
  recordIdSchema,
  revisionIdSchema,
  auditEventIdSchema,
  transactionIdSchema,
  createRecordId,
  createRevisionId,
  createAuditEventId,
  createTransactionId,
  type RecordId,
  type RevisionId,
  type AuditEventId,
} from "./identifiers";

const FIXED_UUID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const NON_V4_UUID = "f47ac10b-58cc-5372-a567-0e02b2c3d479";

describe("identifier schemas", () => {
  it.each([
    ["recordIdSchema", recordIdSchema],
    ["revisionIdSchema", revisionIdSchema],
    ["auditEventIdSchema", auditEventIdSchema],
    ["transactionIdSchema", transactionIdSchema],
  ])("%s accepts a valid UUID v4", (_name, schema) => {
    expect(schema.parse(FIXED_UUID_V4)).toBe(FIXED_UUID_V4);
  });

  it.each([
    ["recordIdSchema", recordIdSchema],
    ["revisionIdSchema", revisionIdSchema],
    ["auditEventIdSchema", auditEventIdSchema],
    ["transactionIdSchema", transactionIdSchema],
  ])("%s rejects a non-v4 UUID", (_name, schema) => {
    expect(() => schema.parse(NON_V4_UUID)).toThrow();
  });

  it.each([
    ["recordIdSchema", recordIdSchema],
    ["revisionIdSchema", revisionIdSchema],
    ["auditEventIdSchema", auditEventIdSchema],
    ["transactionIdSchema", transactionIdSchema],
  ])("%s rejects a malformed string", (_name, schema) => {
    expect(() => schema.parse("not-a-uuid")).toThrow();
  });

  it.each([
    ["recordIdSchema", recordIdSchema],
    ["revisionIdSchema", revisionIdSchema],
    ["auditEventIdSchema", auditEventIdSchema],
    ["transactionIdSchema", transactionIdSchema],
  ])("%s rejects an empty string", (_name, schema) => {
    expect(() => schema.parse("")).toThrow();
  });
});

describe("identifier generators", () => {
  it.each([
    ["createRecordId", createRecordId, recordIdSchema],
    ["createRevisionId", createRevisionId, revisionIdSchema],
    ["createAuditEventId", createAuditEventId, auditEventIdSchema],
    ["createTransactionId", createTransactionId, transactionIdSchema],
  ])("%s returns a value accepted by its schema", (_name, gen, schema) => {
    const id = gen();
    expect(schema.parse(id)).toBe(id);
  });

  it("generators produce unique values", () => {
    expect(createRecordId()).not.toBe(createRecordId());
  });
});

describe("branded type distinctness (compile-time)", () => {
  it("a RecordId cannot be assigned where a RevisionId is required", () => {
    // @ts-expect-error: RecordId and RevisionId are distinct branded types.
    const _vid: RevisionId = FIXED_UUID_V4 as RecordId;
    expect(_vid as string).toBe(FIXED_UUID_V4);
  });

  it("a RecordId cannot be passed where an AuditEventId parameter is required", () => {
    function takeAudit(_id: AuditEventId): void {}

    const rid: RecordId = FIXED_UUID_V4 as RecordId;
    // @ts-expect-error: RecordId is not assignable to AuditEventId.
    takeAudit(rid);
  });
});