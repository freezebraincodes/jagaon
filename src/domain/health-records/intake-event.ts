import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 5.2 / 5.8: Shared boundaries ---

export const INTAKE_EVENT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const INTAKE_EVENT_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
] as const;

// --- Section 5.2: Typed revision reference to SYMPTOM_REPORT ---

const symptomReportRefSchema = createTypedRevisionRefSchema(
  z.literal("SYMPTOM_REPORT"),
);

// --- Section 5.2: IntakeKind ---

export const intakeKindSchema = z.enum([
  "MEAL",
  "SNACK",
  "TEA",
  "DESSERT",
  "DRINK",
  "OTHER",
]);

export type IntakeKind = z.infer<typeof intakeKindSchema>;

// --- Section 5.2: PatientDefinedIntakeSlotKey (branded string) ---

// Uses the project's established structural-brand transform so the runtime
// schema and the exported PatientDefinedIntakeSlotKey type agree.
type Brand<T, B extends string> = T & { readonly __brand: B };

export type PatientDefinedIntakeSlotKey = Brand<string, "PatientDefinedIntakeSlotKey">;

export const patientDefinedIntakeSlotKeySchema = z
  .string()
  .min(1)
  .transform((val) => val as PatientDefinedIntakeSlotKey);

// --- Section 5.2: IntakeSlot ---

const standardMealSlotSchema = z.strictObject({
  kind: z.literal("STANDARD_MEAL"),
  code: z.enum(["BREAKFAST", "LUNCH", "DINNER", "SUPPER"]),
});

const patientDefinedSlotSchema = z.strictObject({
  kind: z.literal("PATIENT_DEFINED"),
  slotKey: patientDefinedIntakeSlotKeySchema,
  label: patientAuthoredNoteSchema,
});

export const intakeSlotSchema = z.discriminatedUnion("kind", [
  standardMealSlotSchema,
  patientDefinedSlotSchema,
]);

export type IntakeSlot = z.infer<typeof intakeSlotSchema>;

// --- Section 5.2: IntakeItem ---

export const intakeItemSchema = z.strictObject({
  kind: z.enum(["FOOD", "DRINK", "OTHER", "UNKNOWN"]),
  label: createBoundedTextSchema(1, 1000),
  quantityText: createBoundedTextSchema(1, 1000).optional(),
});

export type IntakeItem = z.infer<typeof intakeItemSchema>;

// --- Section 5.2: IntakeReason ---

export const intakeReasonSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("JUST_FELT_LIKE_IT") }),
  z.strictObject({ kind: z.literal("HUNGRY") }),
  z.strictObject({ kind: z.literal("SOCIAL_OCCASION") }),
  z.strictObject({
    kind: z.literal("FEELING_UNWELL"),
    symptomRefs: z.tuple([symptomReportRefSchema]).rest(symptomReportRefSchema),
  }),
  z.strictObject({ kind: z.literal("TREATING_KNOWN_OR_SUSPECTED_LOW") }),
  z.strictObject({
    kind: z.literal("OTHER"),
    explanation: patientAuthoredNoteSchema,
  }),
  z.strictObject({ kind: z.literal("NOT_SURE") }),
  z.strictObject({ kind: z.literal("PREFER_NOT_TO_SAY") }),
]);

export type IntakeReason = z.infer<typeof intakeReasonSchema>;

// --- Section 5.2: IntakeEventPayload ---

export type IntakeEventPayload = {
  intakeKind: IntakeKind;
  intakeSlot?: IntakeSlot;
  occasion: "ROUTINE" | "AD_HOC" | "UNKNOWN";
  foodIncluded: "YES" | "NO" | "UNKNOWN";
  drinkIncluded: "YES" | "NO" | "UNKNOWN";
  items: IntakeItem[];
  reason?: IntakeReason;
  patientNote?: PatientAuthoredNote;
};

export const intakeEventPayloadSchema = z
  .strictObject({
    intakeKind: intakeKindSchema,
    intakeSlot: intakeSlotSchema.optional(),
    occasion: z.enum(["ROUTINE", "AD_HOC", "UNKNOWN"]),
    foodIncluded: z.enum(["YES", "NO", "UNKNOWN"]),
    drinkIncluded: z.enum(["YES", "NO", "UNKNOWN"]),
    items: z.array(intakeItemSchema),
    reason: intakeReasonSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  })
  .superRefine((val, ctx) => {
    // A STANDARD_MEAL slot is valid only when intakeKind is MEAL.
    if (
      val.intakeSlot?.kind === "STANDARD_MEAL" &&
      val.intakeKind !== "MEAL"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intakeSlot"],
        message: "STANDARD_MEAL slot is valid only when intakeKind is MEAL",
      });
    }
  });