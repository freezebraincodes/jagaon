import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  revisionActionSchema, createRecordRevisionSchema, recordHeadSchema,
  validateRevisionLineage, validateExpectedHead, assertActionableHead,
  REVISION_ACTIONS, type RecordRevision, type RecordHead,
} from "./revision";
import { recordTypeSchema } from "./record-catalogue";
import { provenanceCoreSchema } from "./provenance";
import { temporalMeaningSchema } from "./temporal";
import type { RecordId, RevisionId, AuditEventId, TransactionId } from "./identifiers";
import type { Instant } from "./time";

const testPayload = z.strictObject({ value: z.number(), unit: z.string() });
type P = z.infer<typeof testPayload>;
const RT = "GLUCOSE_READING" as const;
type RT = typeof RT;
const tSchema = createRecordRevisionSchema(recordTypeSchema, testPayload, temporalMeaningSchema, provenanceCoreSchema);

const RID = "f47ac10b-58cc-4372-a567-0e02b2c3d479" as RecordId;
const V1 = "a47ac10b-58cc-4372-a567-0e02b2c3d479" as RevisionId;
const V2 = "b47ac10b-58cc-4372-a567-0e02b2c3d479" as RevisionId;
const V3 = "c47ac10b-58cc-4372-a567-0e02b2c3d479" as RevisionId;
const AID = "d47ac10b-58cc-4372-a567-0e02b2c3d479" as AuditEventId;
const TID = "e47ac10b-58cc-4372-a567-0e02b2c3d479" as TransactionId;
const T0 = "2026-09-27T10:00:00Z" as Instant;
const T1 = "2026-09-27T11:00:00Z" as Instant;
const AT = { kind: "ATEMPORAL" as const };
const PV = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" } as const;
const PL: P = { value: 5.5, unit: "mmol/L" };
type Rev = RecordRevision<RT, P, typeof AT, typeof PV>;

function mk1(o?: Partial<Rev>): Rev {
  return { schemaVersion: 1, recordType: RT, recordId: RID, revisionId: V1, revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: T0, revisionCreatedAt: T0, temporal: AT, provenance: PV, auditEventId: AID, transactionId: TID, payload: PL, ...o };
}
function mk2(o?: Partial<Rev>): Rev {
  return { schemaVersion: 1, recordType: RT, recordId: RID, revisionId: V2, revisionNumber: 2, previousRevisionId: V1, action: "CORRECT", recordedAt: T0, revisionCreatedAt: T1, temporal: AT, provenance: PV, auditEventId: AID, transactionId: TID, payload: PL, ...o };
}
function mkHead(o?: Partial<RecordHead>): RecordHead {
  return { recordId: RID, recordType: RT, headRevisionId: V1, headRevisionNumber: 1, state: "ACTIVE", updatedAt: T0, ...o };
}

const FAIL = "INVALID_REVISION_LINEAGE" as const;

describe("revisionActionSchema", () => {
  it("has exactly 8 actions", () => {
    expect(REVISION_ACTIONS).toHaveLength(8);
    expect(REVISION_ACTIONS).toEqual(
      expect.arrayContaining(["CREATE","UPDATE","CORRECT","SUPERSEDE","CONFIRM","REJECT","EXPIRE","SYSTEM_DERIVE"]),
    );
  });
  it("rejects DELETE", () => {
    expect(() => revisionActionSchema.parse("DELETE")).toThrow();
  });
});

describe("createRecordRevisionSchema", () => {
  it("accepts a valid revision", () => {
    expect(tSchema.parse(mk1()).action).toBe("CREATE");
  });
  it("rejects unknown keys", () => {
    expect(() => tSchema.parse({ ...mk1(), x: 1 })).toThrow();
  });
  it("rejects a non-string-producing record-type schema at compile time", () => {
    // @ts-expect-error: z.number() does not produce a string, so it must not
    // be accepted as the record-type schema.
    createRecordRevisionSchema(z.number(), testPayload, temporalMeaningSchema, provenanceCoreSchema);
  });
});

describe("validateRevisionLineage", () => {
  it("accepts valid first revision", () => {
    expect(validateRevisionLineage(null, mk1()).ok).toBe(true);
  });
  it("rejects first number != 1", () => {
    const r = validateRevisionLineage(null, mk1({ revisionNumber: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects first action != CREATE", () => {
    const r = validateRevisionLineage(null, mk1({ action: "UPDATE" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects first with non-null predecessor", () => {
    const r = validateRevisionLineage(null, mk1({ previousRevisionId: V2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("accepts valid linear successor", () => {
    expect(validateRevisionLineage(mk1(), mk2()).ok).toBe(true);
  });
  it("rejects skipped number", () => {
    const r = validateRevisionLineage(mk1(), mk2({ revisionNumber: 3 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects wrong predecessor", () => {
    const r = validateRevisionLineage(mk1(), mk2({ previousRevisionId: V3 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects changed record ID", () => {
    const r = validateRevisionLineage(mk1(), mk2({ recordId: "11111111-2222-4333-8444-555555555555" as RecordId }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects changed record type", () => {
    const r = validateRevisionLineage(mk1(), mk2({ recordType: "KETONE_READING" as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects changed recordedAt", () => {
    const r = validateRevisionLineage(mk1(), mk2({ recordedAt: "2026-09-28T10:00:00Z" as Instant }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects revisionCreatedAt before recordedAt on first revision", () => {
    const r = validateRevisionLineage(null, mk1({ revisionCreatedAt: "2026-09-26T10:00:00Z" as Instant }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects revisionCreatedAt before recordedAt on successor", () => {
    const r = validateRevisionLineage(mk1(), mk2({ revisionCreatedAt: "2026-09-26T10:00:00Z" as Instant }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
  it("rejects reuse of CREATE on successor", () => {
    const r = validateRevisionLineage(mk1(), mk2({ action: "CREATE" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FAIL);
  });
});

describe("validateExpectedHead", () => {
  it("accepts when head revision ID matches", () => {
    const r = validateExpectedHead(mkHead(), V1, 1);
    expect(r.ok).toBe(true);
  });
  it("accepts when head revision number matches", () => {
    const r = validateExpectedHead(mkHead(), V1, 1);
    expect(r.ok).toBe(true);
  });
  it("rejects stale expected head (revision ID mismatch)", () => {
    const r = validateExpectedHead(mkHead(), V2, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REVISION_CONFLICT");
  });
  it("rejects stale expected head (revision number mismatch)", () => {
    const r = validateExpectedHead(mkHead(), V1, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REVISION_CONFLICT");
  });
});

describe("assertActionableHead", () => {
  it("accepts an ACTIVE head", () => {
    const r = assertActionableHead(mkHead());
    expect(r.ok).toBe(true);
  });
  it("rejects a DELETED head with DELETED_RECORD_NOT_ACTIONABLE", () => {
    const r = assertActionableHead(mkHead({ state: "DELETED" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DELETED_RECORD_NOT_ACTIONABLE");
  });
});

describe("recordHeadSchema", () => {
  it("accepts a valid ACTIVE head", () => {
    expect(recordHeadSchema.parse(mkHead()).state).toBe("ACTIVE");
  });
  it("accepts a DELETED head", () => {
    expect(recordHeadSchema.parse(mkHead({ state: "DELETED" })).state).toBe("DELETED");
  });
  it("rejects unknown state", () => {
    expect(() => recordHeadSchema.parse({ ...mkHead(), state: "DRAFT" })).toThrow();
  });
  it("rejects unknown keys", () => {
    expect(() => recordHeadSchema.parse({ ...mkHead(), x: 1 })).toThrow();
  });
});