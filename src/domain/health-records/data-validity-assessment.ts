import { z } from "zod";
import type { RevisionId } from "../shared/identifiers";
import { revisionIdSchema } from "../shared/identifiers";
import type { Instant } from "../shared/time";
import { instantSchema } from "../shared/time";

// --- Section 3.6: DataValidityAssessment ---

export const dataValidityOutcomeSchema = z.enum([
  "ROUTABLE_CURRENT",
  "ROUTABLE_HISTORICAL",
  "CONFIRM_REQUIRED",
  "MEASUREMENT_UNCERTAINTY",
  "UNUSABLE",
]);

export type DataValidityOutcome = z.infer<typeof dataValidityOutcomeSchema>;

export type DataValidityAssessment<TReasonCode extends string> = {
  sourceRevisionId: RevisionId;
  evaluatedAt: Instant;
  ruleVersion: string;
  outcome: DataValidityOutcome;
  reasonCodes: TReasonCode[];
};

// Schema factory: accepts the entity's reason-code schema so only approved
// reason codes compose. The spec does not define reason codes here.
export function createDataValidityAssessmentSchema<
  TReasonCodeSchema extends z.ZodType<string>,
>(
  reasonCodeS: TReasonCodeSchema,
) {
  return z.strictObject({
    sourceRevisionId: revisionIdSchema,
    evaluatedAt: instantSchema,
    ruleVersion: z.string().min(1),
    outcome: dataValidityOutcomeSchema,
    reasonCodes: z.array(reasonCodeS),
  });
}

// Re-export for backward-compatible naming matching the spec.
export {
  dataValidityOutcomeSchema as dataValidityAssessmentOutcomeSchema,
};