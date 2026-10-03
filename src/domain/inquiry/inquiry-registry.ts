import type { RecordType } from "../shared/record-catalogue";

/**
 * Closed, versioned Inquiry registries (domain Sections 9.2–9.5 and 9.10).
 *
 * Every definition, option, semantic value, template and reason code that an
 * Inquiry record may name is listed here exactly once. Registry membership is
 * not activation: each definition carries one typed disposition, and only an
 * `ENABLED` definition can produce a candidate. Nothing here reads runtime
 * input, configuration or persisted state.
 */

export const INQUIRY_PURPOSES = Object.freeze([
  "PATTERN_CONTEXT",
  "RECONCILIATION",
  "RECORD_CLARIFICATION",
  "PROGRESSIVE_LEARNING",
  "CARE_PREPARATION",
] as const);

export type InquiryPurpose = (typeof INQUIRY_PURPOSES)[number];

export const INQUIRY_SENSITIVITIES = Object.freeze(["ORDINARY", "SENSITIVE", "HIGH_RISK_DETERMINISTIC_ONLY"] as const);

export type InquirySensitivity = (typeof INQUIRY_SENSITIVITIES)[number];

export const INQUIRY_PRESENTATION_CLASSES = Object.freeze(["INLINE_CLARIFICATION", "CONTEXTUAL", "OPPORTUNISTIC"] as const);

export type InquiryPresentationClass = (typeof INQUIRY_PRESENTATION_CLASSES)[number];

export const INQUIRY_PRESENTATION_SURFACES = Object.freeze([
  "INLINE",
  "INSIGHT_CARD",
  "DIALOG",
  "HOME_PROMPT",
  "CONVERSATIONAL_MESSAGE",
] as const);

export type InquiryPresentationSurface = (typeof INQUIRY_PRESENTATION_SURFACES)[number];

// --- Options and reviewed semantic values -----------------------------------------

/** Reviewed bounded-choice option keys of every registered definition version. */
export const INQUIRY_ANSWER_OPTION_KEYS = Object.freeze([
  "FORGOT",
  "ROUTINE_CHANGED",
  "AWAY_FROM_HOME",
  "ACCESS_DIFFICULTY",
  "SIDE_EFFECT_CONCERN",
] as const);

export type InquiryAnswerOptionKeyValue = (typeof INQUIRY_ANSWER_OPTION_KEYS)[number];

/** Reviewed semantic values. They are descriptive labels, never causes or diagnoses. */
export const INQUIRY_SEMANTIC_VALUE_KEYS = Object.freeze([
  "BARRIER_SELECTED_FORGOT",
  "BARRIER_SELECTED_ROUTINE_CHANGED",
  "BARRIER_SELECTED_AWAY_FROM_HOME",
  "BARRIER_SELECTED_ACCESS_DIFFICULTY",
  "BARRIER_SELECTED_SIDE_EFFECT_CONCERN",
] as const);

export type InquirySemanticValueKeyValue = (typeof INQUIRY_SEMANTIC_VALUE_KEYS)[number];

// --- Templates ---------------------------------------------------------------------

export const INQUIRY_TEMPLATES = Object.freeze({
  "medication-occasion-barrier.dialog": Object.freeze({ versions: Object.freeze(["1"]) }),
} as const);

export type InquiryTemplateKeyValue = keyof typeof INQUIRY_TEMPLATES;

// --- Closed decision-reason registry ------------------------------------------------

export const INQUIRY_DECISION_REASON_CODES = Object.freeze([
  // eligibility
  "PURPOSE_APPROVED",
  "DEFINITION_NOT_ENABLED",
  "BASIS_CURRENT_EXPLICIT_STATE",
  "BASIS_NOT_CURRENT",
  "BASIS_STATE_NOT_ELIGIBLE",
  "BASIS_OCCASION_NOT_EXACT",
  "PERMITTED_CONSEQUENCE_FACTUAL_COUNT",
  "NO_CURRENT_ANSWER",
  "CURRENT_ANSWER_PRESENT",
  "REVIEWED_NEUTRAL_TEMPLATE",
  "REPORTED_CONCERN_OUTSIDE_DEFINITION",
  "OCCASION_ANSWERABLE",
  "OCCASION_NO_LONGER_ANSWERABLE",
  "NO_BLOCKING_DISPOSITION",
  "PREVIOUSLY_DECLINED",
  "PREVIOUSLY_DISMISSED",
  "PREVIOUSLY_NOT_SURE",
  "PREVIOUSLY_EXPIRED",
  "SNOOZE_NOT_ELAPSED",
  "WITHIN_FACTUAL_COUNT_WINDOW",
  "OUTSIDE_FACTUAL_COUNT_WINDOW",
  "UNCERTAINTY_AND_REFUSAL_OFFERED",
  "DESTINATION_DEFINED",
  // queue and budget
  "EXPLICIT_RECORD_IN_CURRENT_VIEW",
  "NOT_IN_CURRENT_VIEW",
  "RECENT_OCCASION",
  "LOW_BURDEN_BOUNDED_CHOICE",
  "NO_COMPETITION",
  "LOWER_PRIORITY_THAN_SELECTED",
  "BUDGET_AVAILABLE",
  "CONCURRENT_PRESENTATION_LIMIT",
  "CONTEXTUAL_DAILY_LIMIT",
  "CONTEXTUAL_WEEKLY_LIMIT",
  "MINIMUM_INTERVAL_NOT_ELAPSED",
  "VIEW_CONTEXTUAL_LIMIT",
] as const);

export type InquiryDecisionReasonCodeValue = (typeof INQUIRY_DECISION_REASON_CODES)[number];

// --- Definitions ---------------------------------------------------------------------

export type InquiryDefinitionDisposition =
  | { kind: "ENABLED" }
  | { kind: "DISABLED_NOT_IMPLEMENTED" }
  | { kind: "DISABLED_PRODUCT_SCOPE" };

export type BoundedChoiceDefinitionContract = {
  kind: "BOUNDED_CHOICE";
  optionKeys: readonly InquiryAnswerOptionKeyValue[];
  allowSomethingElse: boolean;
  allowNotSure: boolean;
  allowPreferNotToSay: boolean;
};

/** One reviewed option: its fixed semantic value and whether it may enter a factual count. */
export type ReviewedOptionMeaning = {
  optionKey: InquiryAnswerOptionKeyValue;
  semanticValueKey: InquirySemanticValueKeyValue;
};

export type EnabledInquiryDefinition = {
  definitionKey: string;
  definitionVersion: string;
  disposition: { kind: "ENABLED" };
  purpose: InquiryPurpose;
  basisRecordTypes: readonly RecordType[];
  answerContract: BoundedChoiceDefinitionContract;
  reviewedOptions: readonly ReviewedOptionMeaning[];
  somethingElseMaximumCodePoints: number;
  sensitivity: InquirySensitivity;
  presentationClass: InquiryPresentationClass;
  surfaces: readonly InquiryPresentationSurface[];
  template: { templateKey: InquiryTemplateKeyValue; templateVersion: string };
  aiWordingPermitted: false;
  ruleVersions: {
    eligibility: string;
    priority: string;
    interruptionBudget: string;
    revalidation: string;
    optionMapping: string;
  };
};

export type DisabledInquiryDefinition = {
  definitionKey: string;
  definitionVersion: string;
  disposition: { kind: "DISABLED_NOT_IMPLEMENTED" } | { kind: "DISABLED_PRODUCT_SCOPE" };
  purpose: InquiryPurpose;
};

export type InquiryDefinition = EnabledInquiryDefinition | DisabledInquiryDefinition;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const MEDICATION_OCCASION_BARRIER_DEFINITION_KEY = "MEDICATION_OCCASION_BARRIER_V1" as const;

const MEDICATION_OCCASION_BARRIER_V1: EnabledInquiryDefinition = {
  definitionKey: MEDICATION_OCCASION_BARRIER_DEFINITION_KEY,
  definitionVersion: "1",
  disposition: { kind: "ENABLED" },
  purpose: "RECORD_CLARIFICATION",
  basisRecordTypes: ["MEDICATION_EVENT"],
  answerContract: {
    kind: "BOUNDED_CHOICE",
    optionKeys: ["FORGOT", "ROUTINE_CHANGED", "AWAY_FROM_HOME", "ACCESS_DIFFICULTY", "SIDE_EFFECT_CONCERN"],
    allowSomethingElse: true,
    allowNotSure: true,
    allowPreferNotToSay: true,
  },
  reviewedOptions: [
    { optionKey: "FORGOT", semanticValueKey: "BARRIER_SELECTED_FORGOT" },
    { optionKey: "ROUTINE_CHANGED", semanticValueKey: "BARRIER_SELECTED_ROUTINE_CHANGED" },
    { optionKey: "AWAY_FROM_HOME", semanticValueKey: "BARRIER_SELECTED_AWAY_FROM_HOME" },
    { optionKey: "ACCESS_DIFFICULTY", semanticValueKey: "BARRIER_SELECTED_ACCESS_DIFFICULTY" },
    { optionKey: "SIDE_EFFECT_CONCERN", semanticValueKey: "BARRIER_SELECTED_SIDE_EFFECT_CONCERN" },
  ],
  somethingElseMaximumCodePoints: 280,
  sensitivity: "ORDINARY",
  presentationClass: "CONTEXTUAL",
  surfaces: ["DIALOG"],
  template: { templateKey: "medication-occasion-barrier.dialog", templateVersion: "1" },
  aiWordingPermitted: false,
  ruleVersions: {
    eligibility: "barrier-eligibility.1",
    priority: "inquiry-priority.1",
    interruptionBudget: "inquiry-budget.1",
    revalidation: "barrier-revalidation.1",
    optionMapping: "barrier-option-mapping.1",
  },
};

/**
 * The complete Packet 8 definition registry. Exactly one definition is
 * enabled; every other approved purpose is explicitly disabled and has no
 * template, option, presentation, subscription or write path.
 */
export const INQUIRY_DEFINITION_REGISTRY: readonly InquiryDefinition[] = deepFreeze([
  MEDICATION_OCCASION_BARRIER_V1,
  { definitionKey: "PATTERN_CONTEXT_V1", definitionVersion: "1", disposition: { kind: "DISABLED_NOT_IMPLEMENTED" }, purpose: "PATTERN_CONTEXT" },
  {
    definitionKey: "PRESCRIPTION_SCHEDULE_RECONCILIATION_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_NOT_IMPLEMENTED" },
    purpose: "RECONCILIATION",
  },
  {
    definitionKey: "RECORD_TIME_CLARIFICATION_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_NOT_IMPLEMENTED" },
    purpose: "RECORD_CLARIFICATION",
  },
  {
    definitionKey: "PROGRESSIVE_ROUTINE_LEARNING_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_NOT_IMPLEMENTED" },
    purpose: "PROGRESSIVE_LEARNING",
  },
  {
    definitionKey: "RECURRING_BARRIER_CONFIRMATION_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_NOT_IMPLEMENTED" },
    purpose: "RECORD_CLARIFICATION",
  },
  {
    definitionKey: "CARE_QUESTION_PREPARATION_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_PRODUCT_SCOPE" },
    purpose: "CARE_PREPARATION",
  },
  {
    definitionKey: "CURRENT_MEDICATION_ACTION_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_PRODUCT_SCOPE" },
    purpose: "RECONCILIATION",
  },
  {
    definitionKey: "SYMPTOM_FOLLOW_UP_V1",
    definitionVersion: "1",
    disposition: { kind: "DISABLED_PRODUCT_SCOPE" },
    purpose: "RECORD_CLARIFICATION",
  },
]);

export function findInquiryDefinition(definitionKey: string, definitionVersion: string): InquiryDefinition | null {
  return (
    INQUIRY_DEFINITION_REGISTRY.find(
      (definition) => definition.definitionKey === definitionKey && definition.definitionVersion === definitionVersion,
    ) ?? null
  );
}

export function isEnabledDefinition(definition: InquiryDefinition | null): definition is EnabledInquiryDefinition {
  return definition !== null && definition.disposition.kind === "ENABLED";
}

/** The single enabled definition, resolved from the registry rather than referenced directly. */
export function enabledInquiryDefinitions(): EnabledInquiryDefinition[] {
  return INQUIRY_DEFINITION_REGISTRY.filter(isEnabledDefinition);
}

/** Surfaces the Packet 8 capability set can present through. */
export const INQUIRY_SURFACE_DISPOSITIONS: Readonly<Record<InquiryPresentationSurface, InquiryDefinitionDisposition>> = deepFreeze({
  INLINE: { kind: "DISABLED_NOT_IMPLEMENTED" },
  INSIGHT_CARD: { kind: "DISABLED_NOT_IMPLEMENTED" },
  DIALOG: { kind: "ENABLED" },
  HOME_PROMPT: { kind: "DISABLED_NOT_IMPLEMENTED" },
  CONVERSATIONAL_MESSAGE: { kind: "DISABLED_PRODUCT_SCOPE" },
});

/** Patient snooze choices for a presented Inquiry; each keeps local wall-clock time. */
export type SnoozeChoice = "TOMORROW" | "THREE_DAYS" | "NEXT_WEEK";
