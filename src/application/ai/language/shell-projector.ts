import { deepFreeze } from "@/application/deep-freeze";
import { careSummaryLocalePack, sectionAssetId } from "@/application/care-preparation/care-summary-locale-pack";
import type { CareSummarySectionId } from "@/domain/care-preparation/care-summary-snapshot";
import { AI_ORGANISABLE_SECTIONS, remoteFields, remoteTokenInventory, SHELL_INPUT_VERSIONS, SHELL_OUTPUT_VERSIONS, shellTaskRequestSchema, type AiLocale, type AtomKind, type GlossKey, type ShellTaskRequest, type SlotPlan } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";

/**
 * Packet 11B.6 value-blind projector (spec Sections 6.2, 11). The only data that crosses the provider
 * boundary: slot identifiers, atom kinds, approved glosses, approved section headings and field budgets.
 * Approval is closed: every gloss must be the approved gloss for its atom kind and locale, every heading an
 * approved AI-organisable section heading, and no free string may carry a digit, unit or reference.
 * 11b.7: the request also names the exact shell output version, the slot plan version and the token
 * inventory, and a remote-ineligible plan is never projected.
 * Observation ownership (2026-10-07): only the plan's REMOTE fields cross the boundary — their paths, budgets, slots (with glosses)
 * and the remote token inventory. An application-owned (LOCAL) field, its slots, glosses and budget are never sent; slot ids keep
 * the plan numbering. A care plan has no local field, so its request is unchanged.
 * Packet 11C (2026-10-08): PERIOD_SUMMARY has no approved gloss, so it can never be projected: a request carrying it is never approved
 * (SHELL_REQUEST_NOT_APPROVED), even if a plan were forced to make its field remote.
 */
export const GLOSSES_BY_KIND: Readonly<Record<AtomKind, readonly GlossKey[]>> = deepFreeze({
  MEANING: ["MEANING_CLAUSE"], DECIMAL_LIST: ["RECORDED_VALUES"], DECIMAL: ["RECORDED_VALUE"], COUNT: ["EVIDENCE_COUNT"], DATE: ["RECORDED_DATE"],
  DATE_RANGE: ["RECORDED_DATE_RANGE"], TIME: ["RECORDED_TIME"], LABEL: ["RECORDED_ITEM", "APPOINTMENT_SERVICE"], QUOTED_TEXT: ["PATIENT_QUESTION"],
  PERIOD_SUMMARY: [],
});
const FORBIDDEN_IN_TEXT = /[0-9０-９%％]|\b(?:fact|claim|option|record|section|limitation)-|\b(?:MMOL_L|MG_DL)\b|mmol\s*\/\s*l|mg\s*\/\s*dl/i;

/**
 * The approved heading for a section in a locale, or null when the locale pack carries no heading asset for it
 * (fail closed: such a section can neither be planned nor approved). Only the pack's own missing-asset error is
 * absorbed; anything else propagates.
 */
export function approvedSectionHeading(locale: AiLocale, sectionId: string): string | null {
  try {
    return careSummaryLocalePack(locale).asset(sectionAssetId(sectionId as CareSummarySectionId));
  } catch (error) {
    if (error instanceof Error && error.message === "SUMMARY_LOCALE_INVALID") return null;
    throw error;
  }
}

export function isApprovedShellTaskRequest(value: unknown, copy: LanguageCopy = AI_LANGUAGE_COPY): value is ShellTaskRequest {
  const parsed = shellTaskRequestSchema.safeParse(value);
  if (!parsed.success) return false;
  const request = parsed.data;
  if (request.runtimeBundleKey !== AI_HYBRID_RUNTIME_BUNDLES[request.taskType].bundleKey) return false;
  const headings = new Set(AI_ORGANISABLE_SECTIONS.flatMap((id) => approvedSectionHeading(request.locale, id) ?? []));
  const slotsOk = request.slots.every((slot) => GLOSSES_BY_KIND[slot.atomKind].some((key) => copy.glosses[key][request.locale] === slot.gloss) && !FORBIDDEN_IN_TEXT.test(slot.gloss));
  const headingsOk = request.sections.every((section) => headings.has(section.heading) && !FORBIDDEN_IN_TEXT.test(section.heading));
  return slotsOk && headingsOk;
}

export function projectShellTaskRequest(plan: SlotPlan, copy: LanguageCopy = AI_LANGUAGE_COPY): ShellTaskRequest {
  if (plan.remote.eligible !== true) throw new Error("SHELL_PLAN_NOT_ELIGIBLE");
  const fields = remoteFields(plan);
  const remotePaths = new Set(fields.map((field) => field.path));
  const request = {
    shellInputVersion: SHELL_INPUT_VERSIONS[plan.taskType],
    shellSchemaVersion: SHELL_OUTPUT_VERSIONS[plan.taskType],
    slotPlanVersion: plan.planVersion,
    taskType: plan.taskType,
    locale: plan.locale,
    runtimeBundleKey: plan.runtimeBundleKey,
    claimFamily: plan.claimFamily,
    tokenInventory: remoteTokenInventory(plan),
    fields: fields.map((field) => ({ path: field.path, requiredSlots: [...field.requiredSlots], maxCodePoints: field.maxCodePoints, maxSentences: field.maxSentences, mayBeAtomOnly: field.mayBeAtomOnly })),
    slots: plan.slots.filter((slot) => remotePaths.has(slot.homeField)).map((slot) => ({ slotId: slot.slotId, atomKind: slot.atomKind, gloss: copy.glosses[slot.glossKey][plan.locale] })),
    sections: plan.sections.map((section) => ({ sectionSlot: section.sectionSlot, heading: section.heading, introPath: section.introPath, bulletPaths: [...section.bulletPaths] })),
  };
  if (!isApprovedShellTaskRequest(request, copy)) throw new Error("SHELL_REQUEST_NOT_APPROVED");
  return deepFreeze(request) as ShellTaskRequest;
}
