import type { Instant } from "../shared/time";
import { INQUIRY_ELIGIBILITY_DIMENSIONS, INQUIRY_PRIORITY_FACTORS } from "./inquiry";

/**
 * Test-only builders for valid Inquiry and response revisions. Not imported
 * by any runtime module.
 */

export const T0 = "2026-10-02T13:00:00.000Z" as Instant;
export const IDS = {
  inquiry: "11111111-1111-4111-8111-111111111111",
  inquiryRev1: "11111111-1111-4111-8111-111111111112",
  inquiryRev2: "11111111-1111-4111-8111-111111111113",
  response: "22222222-2222-4222-8222-222222222221",
  responseRev1: "22222222-2222-4222-8222-222222222222",
  event: "33333333-3333-4333-8333-333333333331",
  eventRev: "33333333-3333-4333-8333-333333333332",
  audit: "44444444-4444-4444-8444-444444444441",
  transaction: "55555555-5555-4555-8555-555555555551",
} as const;

export const SYSTEM_PROVENANCE = {
  sourceKind: "SYSTEM_DERIVATION",
  captureMethod: "RULE_ENGINE",
  initiator: "JAGAON_SYSTEM",
  assistance: "NONE",
} as const;

export const PATIENT_INQUIRY_PROVENANCE = {
  sourceKind: "PATIENT_RESPONSE",
  captureMethod: "INQUIRY",
  initiator: "PATIENT",
  assistance: "NONE",
} as const;

export const BARRIER_CONTRACT = {
  kind: "BOUNDED_CHOICE",
  optionKeys: ["FORGOT", "ROUTINE_CHANGED", "AWAY_FROM_HOME", "ACCESS_DIFFICULTY", "SIDE_EFFECT_CONCERN"],
  allowSomethingElse: true,
  allowNotSure: true,
  allowPreferNotToSay: true,
} as const;

export function eventRef() {
  return { recordType: "MEDICATION_EVENT", recordId: IDS.event, revisionId: IDS.eventRev };
}

export function allDimensions(outcome: "PASS" | "FAIL" | "INDETERMINATE" = "PASS") {
  return INQUIRY_ELIGIBILITY_DIMENSIONS.map((dimension) => ({ dimension, outcome, reasonCodes: [] }));
}

export function allFactors(effect: "INCREASE_PRIORITY" | "NO_CHANGE" | "BLOCK" = "NO_CHANGE") {
  return INQUIRY_PRIORITY_FACTORS.map((factor) => ({ factor, effect, reasonCodes: [] }));
}

export function barrierPayload(lifecycle: unknown = { state: "CANDIDATE" }) {
  return {
    definition: { definitionKey: "MEDICATION_OCCASION_BARRIER_V1", definitionVersion: "1" },
    basis: { purpose: "RECORD_CLARIFICATION", records: [eventRef()] },
    answerContract: BARRIER_CONTRACT,
    deduplicationKey: "MEDICATION_OCCASION_BARRIER_V1:rx:night:2026-10-02",
    sensitivity: "ORDINARY",
    expiresAt: "2026-10-16T13:00:00.000Z",
    lifecycle,
  };
}

export function barrierPresentation(presentationKey = "p-1", presentedAt: string = T0) {
  return {
    presentationKey,
    presentedAt,
    presentationClass: "CONTEXTUAL",
    surface: "DIALOG",
    locale: "en-SG",
    content: {
      leadIn: "You recorded Skipped for Lantus (demo) on 2 Oct. Answering is optional.",
      question: "Would you like to record anything that made this difficult?",
      options: [
        { optionKey: "FORGOT", label: "Forgot" },
        { optionKey: "ROUTINE_CHANGED", label: "Routine changed" },
        { optionKey: "AWAY_FROM_HOME", label: "Away from home" },
        { optionKey: "ACCESS_DIFFICULTY", label: "Access difficulty" },
        { optionKey: "SIDE_EFFECT_CONCERN", label: "Side-effect concern" },
      ],
    },
    wordingSource: { kind: "DETERMINISTIC_TEMPLATE", templateKey: "medication-occasion-barrier.dialog", templateVersion: "1" },
    revalidation: {
      evaluatedAt: presentedAt,
      ruleVersion: "barrier-revalidation.1",
      outcome: "VALID_FOR_PRESENTATION",
      basisRevisions: [eventRef()],
    },
  };
}

export function inquiryRevision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: "INQUIRY",
    recordId: IDS.inquiry,
    revisionId: IDS.inquiryRev1,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: T0,
    revisionCreatedAt: T0,
    temporal: { kind: "ATEMPORAL" },
    provenance: SYSTEM_PROVENANCE,
    auditEventId: IDS.audit,
    transactionId: IDS.transaction,
    payload: barrierPayload(),
    ...overrides,
  };
}

export const NOT_APPLICABLE_DISPOSITION = {
  applicability: "NOT_APPLICABLE",
  determinedAt: T0,
  capabilityManifestVersion: "8.1",
  reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
} as const;

export function responsePayload(overrides: Record<string, unknown> = {}) {
  return {
    inquiryPresentation: {
      inquiry: { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev2 },
      presentationKey: "p-1",
    },
    answeredAt: T0,
    submittedThrough: "DIALOG",
    responseKind: "CONTEXT",
    rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "ROUTINE_CHANGED" },
    interpretation: {
      kind: "DETERMINISTIC_MAPPING",
      mappingVersion: "barrier-option-mapping.1",
      meaning: { kind: "REVIEWED_SEMANTIC_VALUE", semanticValueKey: "BARRIER_SELECTED_ROUTINE_CHANGED" },
    },
    safetyDisposition: NOT_APPLICABLE_DISPOSITION,
    processing: { state: "RECORDED" },
    ...overrides,
  };
}

export function responseRevision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recordType: "INQUIRY_RESPONSE",
    recordId: IDS.response,
    revisionId: IDS.responseRev1,
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: T0,
    revisionCreatedAt: T0,
    temporal: { kind: "ATEMPORAL" },
    provenance: PATIENT_INQUIRY_PROVENANCE,
    auditEventId: IDS.audit,
    transactionId: IDS.transaction,
    payload: responsePayload(),
    ...overrides,
  };
}
