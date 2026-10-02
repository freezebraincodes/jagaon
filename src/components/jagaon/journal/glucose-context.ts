import type { AppMessages } from "@/i18n/types";

/**
 * Exact mapping between the frame 02 context chips and the domain's
 * patient-selected slots. Each chip is one specific slot, so the stored fact
 * is exactly what the person tapped; "Just checking" is the domain's OTHER
 * slot (a check not tied to a meal or bedtime).
 */

export type GlucoseContextChoice =
  | "BEFORE_BREAKFAST"
  | "BEFORE_LUNCH"
  | "BEFORE_DINNER"
  | "BEDTIME"
  | "JUST_CHECKING";

export type GlucoseMealChoice = "BREAKFAST" | "LUNCH" | "DINNER";

export type PatientSelectedGlucoseSlot =
  | "BEFORE_BREAKFAST"
  | "BEFORE_LUNCH"
  | "BEFORE_DINNER"
  | "BEDTIME"
  | "OTHER";

export type GlucoseContextPayload = {
  kind: "PATIENT_SELECTED_SLOT";
  slot: PatientSelectedGlucoseSlot;
};

export const GLUCOSE_CONTEXT_CHOICES: readonly GlucoseContextChoice[] = Object.freeze([
  "BEFORE_BREAKFAST",
  "BEFORE_LUNCH",
  "BEFORE_DINNER",
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
    case "BEFORE_LUNCH":
      return glucose.contextBeforeLunch;
    case "BEFORE_DINNER":
      return glucose.contextBeforeDinner;
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
  }
  const match = /^AFTER_(BREAKFAST|LUNCH|DINNER)$/.exec(code);
  if (!match) return null;
  return `${glucose.contextAfterMeal} · ${glucoseMealLabel(messages, match[1] as GlucoseMealChoice)}`;
}
