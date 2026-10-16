import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { ScheduleMessages } from "@/i18n/types";
import {
  INQUIRY_ANSWER_OPTION_KEYS,
  INQUIRY_DEFINITION_REGISTRY,
  INQUIRY_SURFACE_DISPOSITIONS,
  enabledInquiryDefinitions,
} from "@/domain/inquiry/inquiry-registry";
import { INQUIRY_CAPABILITY_MANIFEST, resolveInquirySafetyDisposition } from "@/inquiry/inquiry-capability-manifest";
import { inquiryResponseSafetyDispositionSchema } from "@/domain/inquiry/inquiry-response";
import { REVERSE_DEPENDENCY_EVALUATORS } from "@/storage/reverse-dependency-row";
import { PACKET_8_SUBSCRIPTIONS } from "@/application/packet8-subscriptions";

/**
 * Packet 8 release manifest: exactly one enabled Inquiry definition, a Safety
 * capability that is absent and recorded as NOT_APPLICABLE, the closed
 * dependency and subscription registrations, and governed bilingual copy
 * without prohibited claims.
 */

describe("Packet 8 Inquiry manifest", () => {
  it("enables only MEDICATION_OCCASION_BARRIER_V1; every other definition is disabled with a reason", () => {
    expect(enabledInquiryDefinitions().map((definition) => definition.definitionKey)).toEqual(["MEDICATION_OCCASION_BARRIER_V1"]);
    expect(INQUIRY_DEFINITION_REGISTRY.map((definition) => [definition.definitionKey, definition.disposition.kind])).toEqual([
      ["MEDICATION_OCCASION_BARRIER_V1", "ENABLED"],
      ["PATTERN_CONTEXT_V1", "DISABLED_NOT_IMPLEMENTED"],
      ["PRESCRIPTION_SCHEDULE_RECONCILIATION_V1", "DISABLED_NOT_IMPLEMENTED"],
      ["RECORD_TIME_CLARIFICATION_V1", "DISABLED_NOT_IMPLEMENTED"],
      ["PROGRESSIVE_ROUTINE_LEARNING_V1", "DISABLED_NOT_IMPLEMENTED"],
      ["RECURRING_BARRIER_CONFIRMATION_V1", "DISABLED_NOT_IMPLEMENTED"],
      ["CARE_QUESTION_PREPARATION_V1", "DISABLED_PRODUCT_SCOPE"],
      ["CURRENT_MEDICATION_ACTION_V1", "DISABLED_PRODUCT_SCOPE"],
      ["SYMPTOM_FOLLOW_UP_V1", "DISABLED_PRODUCT_SCOPE"],
    ]);
    expect(Object.isFrozen(INQUIRY_DEFINITION_REGISTRY)).toBe(true);
    expect(Object.entries(INQUIRY_SURFACE_DISPOSITIONS).filter(([, disposition]) => disposition.kind === "ENABLED").map(([surface]) => surface)).toEqual([
      "DIALOG",
    ]);
    const [barrier] = enabledInquiryDefinitions();
    expect(barrier).toMatchObject({ sensitivity: "ORDINARY", presentationClass: "CONTEXTUAL", aiWordingPermitted: false });
    expect(barrier!.answerContract.optionKeys).toEqual([...INQUIRY_ANSWER_OPTION_KEYS]);
  });

  it("declares Safety absent and resolves every accepted response to NOT_APPLICABLE", () => {
    expect(INQUIRY_CAPABILITY_MANIFEST).toMatchObject({
      manifestVersion: "8.1",
      profile: "HACKATHON_DEMO",
      safety: { kind: "ABSENT", reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT" },
      proactiveOrdinaryPush: { kind: "DISABLED_PRODUCT_SCOPE" },
    });
    expect(Object.isFrozen(INQUIRY_CAPABILITY_MANIFEST.safety)).toBe(true);
    const disposition = resolveInquirySafetyDisposition(INQUIRY_CAPABILITY_MANIFEST, "2026-10-04T13:30:00.000Z" as never);
    expect(disposition).toEqual({
      applicability: "NOT_APPLICABLE",
      determinedAt: "2026-10-04T13:30:00.000Z",
      capabilityManifestVersion: "8.1",
      reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
    });
    expect(inquiryResponseSafetyDispositionSchema.safeParse(disposition).success).toBe(true);
  });

  it("registers only the Packet 8 reverse-dependency owners and subscriptions", () => {
    expect(REVERSE_DEPENDENCY_EVALUATORS["inquiry.medication-occasion-barrier"]).toEqual({
      versions: ["8.1"],
      owner: "INQUIRY",
      dependentRecordType: "INQUIRY",
      roles: ["INQUIRY_BASIS"],
    });
    expect(REVERSE_DEPENDENCY_EVALUATORS["care-plan.reminder-target"]).toEqual({
      versions: ["8.1"],
      owner: "CARE_PLAN",
      dependentRecordType: "REMINDER",
      roles: ["REMINDER_TARGET"],
    });
    expect(PACKET_8_SUBSCRIPTIONS.map((subscription) => [subscription.eventName, subscription.recordType, subscription.consumer, subscription.eligibilityFilterKey])).toEqual([
      ["MEDICATION_EVENT_RECORDED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY", "EXPLICIT_SKIPPED_OR_UNSURE.1"],
      ["MEDICATION_EVENT_CORRECTED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY", "ALL_EVENTS.1"],
      ["PATIENT_RECORD_DELETED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY", "ALL_EVENTS.1"],
      ["PRESCRIPTION_VERSION_REVISED", "PRESCRIPTION_VERSION", "REMINDER_RECONCILIATION", "ALL_EVENTS.1"],
      ["PATIENT_RECORD_DELETED", "PRESCRIPTION_VERSION", "REMINDER_RECONCILIATION", "ALL_EVENTS.1"],
    ]);
    // No Safety consumer and no Packet 7B consumer is subscribed.
    expect(PACKET_8_SUBSCRIPTIONS.some((subscription) => /SAFETY|BARRIER_LEARNING|RECURRING/.test(subscription.consumer))).toBe(false);
  });
});

/** Every string (and sample-rendered template) in the schedule catalogue. */
function scheduleStrings(copy: ScheduleMessages): string[] {
  const out: string[] = [];
  for (const value of Object.values(copy)) {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") out.push(String((value as (...args: unknown[]) => string)("A", "B", "C")));
    else if (value && typeof value === "object") out.push(...Object.values(value as Record<string, string>));
  }
  return out;
}

describe("Packet 8 bilingual copy", () => {
  const en = getMessages("en-SG").schedule;
  const zh = getMessages("zh-SG").schedule;

  it("has the same keys in en-SG and zh-SG with no empty value", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...scheduleStrings(en), ...scheduleStrings(zh)]) expect(value.trim().length).toBeGreaterThan(0);
  });

  it("uses the approved matrix wording for the governed strings", () => {
    expect([en.title, zh.title]).toEqual(["Medication schedule", "用药时间表"]);
    expect([en.notRecorded, zh.notRecorded]).toEqual(["Not recorded", "未记录"]);
    expect(en.barrierQuestion).toBe("Would you like to record anything that made this difficult?");
    expect([en.optionTaken, en.optionSkipped, en.optionNotSure, en.optionDecline]).toEqual(["Taken", "Skipped", "Not sure", "Prefer not to record"]);
    expect(en.reminderLimitation).toBe("A reminder records nothing about whether the action happened.");
  });

  it("contains no adherence judgement, clinical interpretation, dose advice or unverified delivery claim", () => {
    const englishForbidden = [
      /ring twice/i,
      /\bmissed\b/i,
      /non-?adherence/i,
      /\bcomplian/i,
      /\brisk\b/i,
      /\burgent/i,
      /\bdiagnos/i,
      /\bimprov/i,
      /\bworsen/i,
      /\bshould (?:take|inject)/i,
      /\byou (?:need|must)\b/i,
      /\bnotification/i,
      /\bsent to\b/i,
    ];
    // Owner decision 2026-10-15: the reminders note says plainly that NO notification is sent; a negation, not a delivery claim.
    const noAlertsNote = (messages: typeof en) => messages.inAppOnly;
    for (const value of scheduleStrings(en).filter((value) => value !== noAlertsNote(en))) {
      for (const pattern of englishForbidden) expect(value, `${pattern} in "${value}"`).not.toMatch(pattern);
    }
    expect(noAlertsNote(en)).toBe("This demo doesn't send reminder alerts yet: no sound or notification.");
    const chineseForbidden = [/漏服/, /依从性差/, /风险/, /紧急/, /诊断/, /改善/, /恶化/, /应该(?:服用|注射)/, /响两次/, /通知/];
    // Owner decision 2026-10-15: the neutral safety line after a skipped dose names the emergency number (紧急 = emergency), which
    // is safety information, not a judgement of the record.
    for (const value of scheduleStrings(zh).filter((value) => value !== noAlertsNote(zh) && value !== zh.skippedSafety)) {
      for (const pattern of chineseForbidden) expect(value, `${pattern} in "${value}"`).not.toMatch(pattern);
    }
    expect(noAlertsNote(zh)).toBe("此演示暂不发送提醒通知：没有声音，也没有通知。");
    expect(zh.skippedSafety).toBe("如果您感到不适，请联系您的护理团队。紧急情况下，请拨打 995。");
  });
});
