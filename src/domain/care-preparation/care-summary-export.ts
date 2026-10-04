import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { instantSchema } from "../shared/time";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";

/**
 * `CARE_SUMMARY_EXPORT` record contract (domain Sections 11.8–11.10).
 *
 * One record is one patient-initiated attempt against one exact approved
 * snapshot revision. It begins `REQUESTED`; one later revision records the
 * terminal outcome actually observed. A print dialog opening never means a
 * clinician received or reviewed anything, and `externalConfirmation` stays
 * `NONE` on every MVP path.
 */

export const CARE_SUMMARY_EXPORT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const CARE_SUMMARY_EXPORT_REVISION_ACTIONS = Object.freeze(["CREATE", "UPDATE"] as const);

/** The hackathon export profile (design Section 7.3, checklist E). */
export const HACKATHON_EXPORT_PROFILE = Object.freeze({ method: "PRINT_DIALOG", artifactFormat: "PRINTABLE_DOCUMENT" } as const);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "SHA256_DIGEST_INVALID");

export const careSummaryExportOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("REQUESTED") }),
  z.strictObject({
    state: z.literal("EXPORTED"),
    completedAt: instantSchema,
    artifactHash: sha256Schema,
    byteLength: z.number().int().nonnegative().safe().optional(),
    evidence: z.enum(["FILE_CREATED_LOCALLY", "OS_SHARE_SHEET_OPENED", "OS_SHARE_API_RESOLVED_UNCONFIRMED", "PRINT_DIALOG_OPENED"]),
  }),
  z.strictObject({
    state: z.literal("CANCELLED"),
    cancelledAt: instantSchema,
    stage: z.enum(["BEFORE_ARTIFACT_CREATION", "DURING_FILE_SELECTION", "IN_SHARE_SHEET", "IN_PRINT_DIALOG"]),
  }),
  z.strictObject({
    state: z.literal("FAILED"),
    failedAt: instantSchema,
    reason: z.enum(["ARTIFACT_GENERATION_FAILED", "SHARE_API_UNAVAILABLE", "OS_HANDOFF_FAILED", "FILE_WRITE_FAILED", "PRINT_UNAVAILABLE", "UNKNOWN_TECHNICAL_FAILURE"]),
  }),
  z.strictObject({ state: z.literal("OUTCOME_UNKNOWN"), lastObservedAt: instantSchema, stage: z.enum(["ARTIFACT_GENERATION", "FILE_HANDOFF", "OS_SHARE", "PRINT"]) }),
]);
export type CareSummaryExportOutcome = z.infer<typeof careSummaryExportOutcomeSchema>;

/**
 * Dormant representations exist only so the closed union is complete; the
 * MVP schema rejects them (EXTERNAL_CONFIRMATION_NOT_ENABLED).
 */
export const careSummaryExternalConfirmationSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("NONE") }),
    z.strictObject({
      state: z.literal("DELIVERED"),
      confirmedAt: instantSchema,
      authorisedIntegrationId: z.string().min(1),
      integrationVersion: z.string().min(1),
      externalConfirmationRef: z.string().min(1),
    }),
    z.strictObject({
      state: z.literal("REVIEWED"),
      deliveredAt: instantSchema,
      reviewedAt: instantSchema,
      authorisedIntegrationId: z.string().min(1),
      integrationVersion: z.string().min(1),
      externalConfirmationRef: z.string().min(1),
    }),
  ])
  .superRefine((confirmation, ctx) => {
    if (confirmation.state !== "NONE") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EXTERNAL_CONFIRMATION_NOT_ENABLED" });
  })
  .transform((): { state: "NONE" } => ({ state: "NONE" }));

const exportRefSchema = createTypedRevisionRefSchema(z.literal("CARE_SUMMARY_EXPORT"));

export const careSummaryExportPayloadSchema = z
  .strictObject({
    snapshot: createTypedRevisionRefSchema(z.literal("CARE_SUMMARY_SNAPSHOT")),
    approvedContentHash: sha256Schema,
    method: z.enum(["FILE_DOWNLOAD", "OS_SHARE_SHEET", "PRINT_DIALOG"]),
    artifactFormat: z.enum(["PDF", "PRINTABLE_DOCUMENT"]),
    requestedAt: instantSchema,
    outcome: careSummaryExportOutcomeSchema,
    externalConfirmation: careSummaryExternalConfirmationSchema,
    replacesExports: z.array(exportRefSchema),
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    // Only a local printable document through the browser print dialog is enabled.
    if (payload.method !== HACKATHON_EXPORT_PROFILE.method || payload.artifactFormat !== HACKATHON_EXPORT_PROFILE.artifactFormat) issue("EXPORT_METHOD_NOT_ENABLED", ["method"]);
    const outcome = payload.outcome;
    if (outcome.state === "EXPORTED" && outcome.evidence !== "PRINT_DIALOG_OPENED") issue("EXPORT_OUTCOME_INVALID", ["outcome"]);
    if (outcome.state === "CANCELLED" && outcome.stage !== "IN_PRINT_DIALOG" && outcome.stage !== "BEFORE_ARTIFACT_CREATION") issue("EXPORT_OUTCOME_INVALID", ["outcome"]);
    if (outcome.state === "FAILED" && !["ARTIFACT_GENERATION_FAILED", "PRINT_UNAVAILABLE", "UNKNOWN_TECHNICAL_FAILURE"].includes(outcome.reason)) issue("EXPORT_OUTCOME_INVALID", ["outcome"]);
    if (outcome.state === "OUTCOME_UNKNOWN" && outcome.stage !== "PRINT" && outcome.stage !== "ARTIFACT_GENERATION") issue("EXPORT_OUTCOME_INVALID", ["outcome"]);
    const terminalAt =
      outcome.state === "EXPORTED" ? outcome.completedAt : outcome.state === "CANCELLED" ? outcome.cancelledAt : outcome.state === "FAILED" ? outcome.failedAt : outcome.state === "OUTCOME_UNKNOWN" ? outcome.lastObservedAt : null;
    if (terminalAt !== null && Date.parse(terminalAt) < Date.parse(payload.requestedAt)) issue("EXPORT_OUTCOME_INVALID", ["outcome"]);
    const replaced = payload.replacesExports.map((ref) => ref.recordId);
    if (new Set(replaced).size !== replaced.length) issue("EXPORT_OUTCOME_INVALID", ["replacesExports"]);
  });

export type CareSummaryExportPayload = z.infer<typeof careSummaryExportPayloadSchema>;

export type CareSummaryExportRevision = RecordRevision<"CARE_SUMMARY_EXPORT", CareSummaryExportPayload, AtemporalMeaning, ProvenanceCore>;

/** One requested revision, then exactly one terminal revision; only the patient initiates. */
export const careSummaryExportRevisionSchema = createRecordRevisionSchema(
  z.literal("CARE_SUMMARY_EXPORT"),
  careSummaryExportPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(CARE_SUMMARY_EXPORT_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  if (revision.provenance.initiator !== "PATIENT" || revision.provenance.sourceKind !== "PATIENT_ENTRY") issue("EXPORT_REQUIRES_PATIENT", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
  const requested = revision.payload.outcome.state === "REQUESTED";
  if (revision.action === "CREATE" && (!requested || revision.revisionNumber !== 1)) issue("EXPORT_MUST_BEGIN_REQUESTED", ["payload", "outcome"]);
  if (revision.action === "UPDATE" && (requested || revision.revisionNumber !== 2)) issue("EXPORT_OUTCOME_INVALID", ["payload", "outcome"]);
}) as unknown as z.ZodType<CareSummaryExportRevision, z.ZodTypeDef, unknown>;
