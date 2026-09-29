import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";

// --- Section 3.5: PatientAuthoredNote ---

export type PatientAuthoredNote = {
  text: string;
  language: "en-SG" | "zh-SG" | "und";
};

export const patientAuthoredNoteSchema = z.strictObject({
  text: createBoundedTextSchema(1, 1000),
  language: z.enum(["en-SG", "zh-SG", "und"]),
});