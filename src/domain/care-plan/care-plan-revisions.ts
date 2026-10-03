import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { temporalMeaningSchema } from "../shared/temporal";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";
import { medicationPayloadSchema, MEDICATION_REVISION_ACTIONS, type MedicationPayload } from "./medication";
import {
  prescriptionVersionPayloadSchema,
  PRESCRIPTION_VERSION_REVISION_ACTIONS,
  type PrescriptionVersionPayload,
} from "./prescription-version";

/**
 * Stored revision envelopes for the Care Plan medication identity and
 * prescription-version payloads (domain Sections 1.4 and 6.2–6.5).
 *
 * A medication identity is ATEMPORAL. A prescription version's temporal
 * meaning is exactly its recorded effective period, so an unknown start or
 * end stays unknown and is never replaced with the entry time.
 */

export type MedicationRevision = RecordRevision<"MEDICATION", MedicationPayload, AtemporalMeaning, ProvenanceCore>;

export const medicationRevisionSchema = createRecordRevisionSchema(
  z.literal("MEDICATION"),
  medicationPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  if (!(MEDICATION_REVISION_ACTIONS as readonly string[]).includes(revision.action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUPPORTED_REVISION_ACTION", path: ["action"] });
  }
}) as unknown as z.ZodType<MedicationRevision, z.ZodTypeDef, unknown>;

const prescriptionTemporalSchema = temporalMeaningSchema.refine((value) => value.kind === "INTERVAL", "PRESCRIPTION_TEMPORAL_IS_INTERVAL");

export type PrescriptionVersionTemporal = Extract<z.infer<typeof temporalMeaningSchema>, { kind: "INTERVAL" }>;

export type PrescriptionVersionRevision = RecordRevision<
  "PRESCRIPTION_VERSION",
  PrescriptionVersionPayload,
  PrescriptionVersionTemporal,
  ProvenanceCore
>;

export const prescriptionVersionRevisionSchema = createRecordRevisionSchema(
  z.literal("PRESCRIPTION_VERSION"),
  prescriptionVersionPayloadSchema,
  prescriptionTemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  if (!(PRESCRIPTION_VERSION_REVISION_ACTIONS as readonly string[]).includes(revision.action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUPPORTED_REVISION_ACTION", path: ["action"] });
  }
  const temporal = revision.temporal as PrescriptionVersionTemporal;
  const period = revision.payload.effectivePeriod;
  if (JSON.stringify(temporal.start) !== JSON.stringify(period.start) || JSON.stringify(temporal.end) !== JSON.stringify(period.end)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TEMPORAL_DISAGREES_WITH_EFFECTIVE_PERIOD", path: ["temporal"] });
  }
}) as unknown as z.ZodType<PrescriptionVersionRevision, z.ZodTypeDef, unknown>;
