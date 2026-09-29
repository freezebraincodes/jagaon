import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";

// --- Section 3.2: PatientProfilePayload ---

export type PatientProfilePayload = {
  preferredName?: string;
  ageEligibility: "ADULT_18_PLUS" | "UNKNOWN";
};

const ageEligibilitySchema = z.enum(["ADULT_18_PLUS", "UNKNOWN"]);

export const patientProfilePayloadSchema = z.strictObject({
  preferredName: createBoundedTextSchema(1, 100).optional(),
  ageEligibility: ageEligibilitySchema,
});