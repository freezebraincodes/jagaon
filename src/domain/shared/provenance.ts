import { z } from "zod";

// --- Section 1.8: Provenance enums ---

export const knowledgeClassSchema = z.enum([
  "PRESCRIBED",
  "PATIENT_STATED",
  "OBSERVED",
  "INFERRED",
]);
export type KnowledgeClass = z.infer<typeof knowledgeClassSchema>;

export const sourceKindSchema = z.enum([
  "PATIENT_ENTRY",
  "PATIENT_RESPONSE",
  "SYSTEM_OBSERVATION",
  "SYSTEM_DERIVATION",
  "IMPORT",
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const captureMethodSchema = z.enum([
  "FORM",
  "INQUIRY",
  "RULE_ENGINE",
  "AI_EXTRACTION",
  "IMPORT",
]);
export type CaptureMethod = z.infer<typeof captureMethodSchema>;

export const changeInitiatorSchema = z.enum([
  "PATIENT",
  "JAGAON_SYSTEM",
  "IMPORT",
]);
export type ChangeInitiator = z.infer<typeof changeInitiatorSchema>;

export const assistanceSchema = z.enum(["NONE", "AI_ASSISTED"]);
export type Assistance = z.infer<typeof assistanceSchema>;

// --- Section 1.8: ProvenanceCore ---
// Strict discriminated-by-sourceKind object that binds source/initiator.
// Contains only sourceKind, captureMethod, initiator, assistance.
// AI is never a source or initiator.

const patientSourceKinds = ["PATIENT_ENTRY", "PATIENT_RESPONSE"] as const;
const systemSourceKinds = ["SYSTEM_OBSERVATION", "SYSTEM_DERIVATION"] as const;

export const provenanceCoreSchema = z
  .strictObject({
    sourceKind: sourceKindSchema,
    captureMethod: captureMethodSchema,
    initiator: changeInitiatorSchema,
    assistance: assistanceSchema,
  })
  .superRefine((val, ctx) => {
    const validInitiator = getValidInitiator(val.sourceKind);
    if (val.initiator !== validInitiator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `INVALID_PROVENANCE_COMBINATION: sourceKind ${val.sourceKind} requires initiator ${validInitiator}`,
        path: ["initiator"],
      });
    }
  });

export type ProvenanceCore = z.infer<typeof provenanceCoreSchema>;

// Helper: the valid initiator for a given source kind.
function getValidInitiator(sourceKind: SourceKind): ChangeInitiator {
  if ((patientSourceKinds as readonly string[]).includes(sourceKind)) {
    return "PATIENT";
  }
  if ((systemSourceKinds as readonly string[]).includes(sourceKind)) {
    return "JAGAON_SYSTEM";
  }
  return "IMPORT";
}