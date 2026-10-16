import type { AppMessages } from "@/i18n/types";

/**
 * Exact mapping between the frame 02 context chips and the domain's
 * patient-selected slots. Each chip is one specific slot, so the stored fact
 * is exactly what the person tapped; "Just checking" is the domain's OTHER
 * slot (a check not tied to a meal or bedtime).
 */

export type GlucoseContextChoice =
  | "BEFORE_BREAKFAST"
  | "AFTER_BREAKFAST"
  | "BEFORE_LUNCH"
  | "AFTER_LUNCH"
  | "BEFORE_DINNER"
  | "AFTER_DINNER"
  | "BEDTIME"
  | "JUST_CHECKING";

export type GlucoseMealChoice = "BREAKFAST" | "LUNCH" | "DINNER";

export type PatientSelectedGlucoseSlot =
  | "BEFORE_BREAKFAST"
  | "AFTER_BREAKFAST"
  | "BEFORE_LUNCH"
  | "AFTER_LUNCH"
  | "BEFORE_DINNER"
  | "AFTER_DINNER"
  | "BEDTIME"
  | "OTHER";

export type GlucoseContextPayload = {
  kind: "PATIENT_SELECTED_SLOT";
  slot: PatientSelectedGlucoseSlot;
};

/** Owner decision 2026-10-16: before and after each meal, in the order of the booklet's columns, then bedtime and just checking. */
export const GLUCOSE_CONTEXT_CHOICES: readonly GlucoseContextChoice[] = Object.freeze([
  "BEFORE_BREAKFAST",
  "AFTER_BREAKFAST",
  "BEFORE_LUNCH",
  "AFTER_LUNCH",
  "BEFORE_DINNER",
  "AFTER_DINNER",
  "BEDTIME",
  "JUST_CHECKING",
]);

export function toGlucoseContextPayload(choice: GlucoseContextChoice): GlucoseContextPayload {
  return {
    kind: "PATIENT_SELECTED_SLOT",
    slot: choice === "JUST_CHECKING" ? "OTHER" : choice,
  };
}

export function glucoseContextChoiceLabel(
  messages: AppMessages,
  choice: GlucoseContextChoice,
): string {
  const glucose = messages.glucose;
  switch (choice) {
    case "BEFORE_BREAKFAST":
      return glucose.contextBeforeBreakfast;
    case "AFTER_BREAKFAST":
      return glucose.contextAfterBreakfast;
    case "BEFORE_LUNCH":
      return glucose.contextBeforeLunch;
    case "AFTER_LUNCH":
      return glucose.contextAfterLunch;
    case "BEFORE_DINNER":
      return glucose.contextBeforeDinner;
    case "AFTER_DINNER":
      return glucose.contextAfterDinner;
    case "BEDTIME":
      return glucose.contextBedtime;
    case "JUST_CHECKING":
      return glucose.contextJustChecking;
  }
}

export function glucoseMealLabel(messages: AppMessages, meal: GlucoseMealChoice): string {
  switch (meal) {
    case "BREAKFAST":
      return messages.meal.breakfast;
    case "LUNCH":
      return messages.meal.lunch;
    case "DINNER":
      return messages.meal.dinner;
  }
}

/**
 * Display label for a stored context code, including codes written by
 * earlier entries. Returns null for codes Packet 6 cannot label exactly.
 */
export function storedGlucoseContextLabel(
  messages: AppMessages,
  code: string | undefined,
): string | null {
  const glucose = messages.glucose;
  switch (code) {
    case undefined:
      return null;
    case "UNSPECIFIED":
      return glucose.contextUnspecified;
    case "FASTING":
      return glucose.contextFasting;
    case "BEFORE_BREAKFAST":
      return glucose.contextBeforeBreakfast;
    case "BEFORE_LUNCH":
      return glucose.contextBeforeLunch;
    case "BEFORE_DINNER":
      return glucose.contextBeforeDinner;
    case "BEDTIME":
      return glucose.contextBedtime;
    case "OTHER":
      return glucose.contextJustChecking;
    case "AFTER_BREAKFAST":
      return glucose.contextAfterBreakfast;
    case "AFTER_LUNCH":
      return glucose.contextAfterLunch;
    case "AFTER_DINNER":
      return glucose.contextAfterDinner;
  }
  return null;
}
