import { z } from "zod";
import { DEMO_CATALOGUE_KEYS, findDemoCatalogueEntry } from "./demo-medicine-catalogue";

/**
 * Strict, versioned Packet 6A onboarding presentation state.
 *
 * This is HACKATHON_DEMO synthetic setup only: it never becomes a
 * PATIENT_PROFILE, MEDICATION or PRESCRIPTION_VERSION revision and emits no
 * domain event. Optional prescription facts are null when unknown; nothing
 * is inferred from another medicine.
 */

export const DEMO_ONBOARDING_ROUTES = Object.freeze([
  "WELCOME",
  "PROFILE",
  "MEDICINES",
  "ADD_MEDICINE",
  "DIRECTIONS",
  "REVIEW",
  "COMPLETE",
  "RESUME",
  "SKIPPED",
  "STORAGE_FAILURE",
] as const);

export type DemoOnboardingRoute = (typeof DEMO_ONBOARDING_ROUTES)[number];

export const DEMO_ONBOARDING_STEPS = Object.freeze([
  "PROFILE",
  "MEDICINES",
  "ADD_MEDICINE",
  "DIRECTIONS",
  "REVIEW",
] as const);

export type DemoOnboardingStep = (typeof DEMO_ONBOARDING_STEPS)[number];

export const DEMO_ONBOARDING_STATUSES = Object.freeze(["IN_PROGRESS", "COMPLETED", "SKIPPED"] as const);
export type DemoOnboardingStatus = (typeof DEMO_ONBOARDING_STATUSES)[number];

export const DEMO_MEDICINE_SOURCES = Object.freeze([
  "PRESCRIPTION_LABEL",
  "CARE_TEAM_DIRECTIONS",
  "PATIENT_ENTERED",
  "UNKNOWN",
] as const);
export type DemoMedicineSource = (typeof DEMO_MEDICINE_SOURCES)[number];

export const DEMO_ONBOARDING_LOCALES = Object.freeze(["en-SG", "zh-SG"] as const);

/** Field length limits; over-long text is rejected, never truncated. */
export const DEMO_TEXT_LIMITS = Object.freeze({
  name: 80,
  shortFact: 120,
  directions: 1000,
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const requiredText = (max: number) =>
  z.string().max(max).refine((value) => value.trim().length > 0, "blank");
const optionalText = (max: number) => requiredText(max).nullable();

const medicineSchema = z
  .strictObject({
    id: z.string().regex(UUID_V4),
    catalogueKey: z.enum(DEMO_CATALOGUE_KEYS as [string, ...string[]]).nullable(),
    enteredName: requiredText(DEMO_TEXT_LIMITS.name),
    displayName: requiredText(DEMO_TEXT_LIMITS.name),
    genericName: optionalText(DEMO_TEXT_LIMITS.name),
    form: optionalText(DEMO_TEXT_LIMITS.shortFact),
    strength: optionalText(DEMO_TEXT_LIMITS.shortFact),
    amountAndUnit: optionalText(DEMO_TEXT_LIMITS.shortFact),
    scheduleOrTiming: optionalText(DEMO_TEXT_LIMITS.shortFact),
    effectiveDate: optionalText(DEMO_TEXT_LIMITS.shortFact),
    verbatimDirections: optionalText(DEMO_TEXT_LIMITS.directions),
    source: z.enum(DEMO_MEDICINE_SOURCES),
    reviewedContentKey: z.enum(["insulin-glargine", "insulin-glulisine"]).nullable(),
  })
  .superRefine((medicine, ctx) => {
    // Every catalogue-derived identity is bound to one exact frozen entry.
    // Free text carries no catalogue-derived generic or reviewed content.
    const entry = findDemoCatalogueEntry(medicine.catalogueKey);
    if (entry && medicine.enteredName !== entry.displayName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entered catalogue identity mismatch" });
    }
    if (entry && medicine.displayName !== entry.displayName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "display catalogue identity mismatch" });
    }
    if (medicine.genericName !== (entry?.genericName ?? null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "generic identity mismatch" });
    }
    if (medicine.reviewedContentKey !== (entry?.reviewedContentKey ?? null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reviewed content mismatch" });
    }
  });

const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    status: z.enum(DEMO_ONBOARDING_STATUSES),
    lastCompletedStep: z.enum(DEMO_ONBOARDING_STEPS).nullable(),
    locale: z.enum(DEMO_ONBOARDING_LOCALES),
    preferredName: optionalText(DEMO_TEXT_LIMITS.name),
    medicines: z.array(medicineSchema),
    updatedAt: z
      .string()
      .datetime({ offset: false })
      .refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp"),
  })
  .superRefine((state, ctx) => {
    const ids = state.medicines.map((medicine) => medicine.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate medicine id" });
    }
  });

export type DemoOnboardingMedicine = {
  id: string;
  catalogueKey: string | null;
  enteredName: string;
  displayName: string;
  genericName: string | null;
  form: string | null;
  strength: string | null;
  amountAndUnit: string | null;
  scheduleOrTiming: string | null;
  effectiveDate: string | null;
  verbatimDirections: string | null;
  source: DemoMedicineSource;
  reviewedContentKey: "insulin-glargine" | "insulin-glulisine" | null;
};

export type DemoOnboardingStateV1 = {
  schemaVersion: 1;
  status: DemoOnboardingStatus;
  lastCompletedStep: DemoOnboardingStep | null;
  locale: "en-SG" | "zh-SG";
  preferredName: string | null;
  medicines: DemoOnboardingMedicine[];
  updatedAt: string;
};

export type DemoOnboardingParseResult =
  | { ok: true; state: DemoOnboardingStateV1 }
  | { ok: false };

export function parseDemoOnboardingState(raw: unknown): DemoOnboardingParseResult {
  const parsed = stateSchema.safeParse(raw);
  return parsed.success ? { ok: true, state: parsed.data as DemoOnboardingStateV1 } : { ok: false };
}

/** 1-based step number shown in "Step N of 5". */
export function stepNumber(step: DemoOnboardingStep): number {
  return DEMO_ONBOARDING_STEPS.indexOf(step) + 1;
}

/** The step to continue from after the last successfully persisted step. */
export function nextDemoOnboardingStep(last: DemoOnboardingStep | null): DemoOnboardingStep {
  if (last === null) return "PROFILE";
  const index = DEMO_ONBOARDING_STEPS.indexOf(last);
  return DEMO_ONBOARDING_STEPS[Math.min(index + 1, DEMO_ONBOARDING_STEPS.length - 1)]!;
}

/** Keeps the furthest step reached when an earlier step is saved again. */
export function furthestStep(
  current: DemoOnboardingStep | null,
  next: DemoOnboardingStep,
): DemoOnboardingStep {
  if (current === null) return next;
  return stepNumber(next) > stepNumber(current) ? next : current;
}
