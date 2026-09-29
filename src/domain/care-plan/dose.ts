import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";
import {
  decimalStringSchema,
  type DecimalString,
} from "../health-records/measurement";

// --- Section 6.3: DoseAmount ---

const doseUnitSchema = z.enum([
  "MCG",
  "MG",
  "G",
  "ML",
  "UNIT",
  "TABLET",
  "CAPSULE",
  "PUFF",
  "DROP",
  "PATCH",
]);

export type DoseUnit = z.infer<typeof doseUnitSchema>;

const doseAmountStandardSchema = z.strictObject({
  value: decimalStringSchema,
  unit: doseUnitSchema,
});

const doseAmountOtherSchema = z.strictObject({
  value: decimalStringSchema,
  unit: z.literal("OTHER"),
  otherUnitText: createBoundedTextSchema(1, 1000),
});

export const doseAmountSchema = z.discriminatedUnion("unit", [
  doseAmountStandardSchema,
  doseAmountOtherSchema,
]);

export type DoseAmount = z.infer<typeof doseAmountSchema>;

// --- Section 6.4: PrescriptionInstructionText ---

export type PrescriptionInstructionText = {
  text: string;
  language: "en-SG" | "zh-SG" | "und";
};

export const prescriptionInstructionTextSchema = z.strictObject({
  text: createBoundedTextSchema(1, 1000),
  language: z.enum(["en-SG", "zh-SG", "und"]),
});