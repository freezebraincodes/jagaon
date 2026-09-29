import { z } from "zod";
import type { RecordType } from "./record-catalogue";
import type { RecordId, RevisionId } from "./identifiers";
import { recordIdSchema, revisionIdSchema } from "./identifiers";

// --- Section 4.2: Typed revision reference ---

// Every context, prescription, recheck, evidence, and safety relationship
// names the exact revision used. A bare identifier that could silently
// resolve to a different later revision is insufficient for historical
// analysis.
export type TypedRevisionRef<T extends RecordType> = {
  recordType: T;
  recordId: RecordId;
  revisionId: RevisionId;
};

// Schema factory: accepts an exact record-type literal schema constrained
// to an approved RecordType so only the approved record type composes.
// Produces a strict object rejecting unknown keys and bare identifiers.
export function createTypedRevisionRefSchema<
  T extends RecordType,
  TRecordTypeSchema extends z.ZodLiteral<T>,
>(recordTypeS: TRecordTypeSchema) {
  return z.strictObject({
    recordType: recordTypeS,
    recordId: recordIdSchema,
    revisionId: revisionIdSchema,
  });
}