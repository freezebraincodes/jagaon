import type { Instant, RecordType } from "@/domain/shared";
import type { TimePoint } from "@/domain/shared/temporal";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import {
  careSummaryExportProjection,
  careSummarySnapshotPayloadSchema,
  type CareSummaryBlock,
  type CareSummaryFactBinding,
  type CareSummaryPayloadSectionId,
  type CareSummaryPurpose,
  type CareSummarySection,
  type CareSummarySectionId,
  type CareSummarySnapshotPayload,
} from "@/domain/care-preparation/care-summary-snapshot";
import { hashCanonicalJson, type Sha256Digest } from "@/application/contracts/canonical-json";
import { careDraftNoticesFor } from "@/application/ai/language/care-draft-notices";
import { careSummaryAiMarkingSection } from "./care-summary-ai-marking";
import {
  CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION,
  CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION,
  CARE_SUMMARY_RENDERER_VERSION,
  CARE_SUMMARY_TEMPLATE_VERSION,
  careSummaryLocalePack,
  limitationAssetId,
  sectionAssetId,
  type CareSummaryLocalePack,
} from "./care-summary-locale-pack";

/**
 * Deterministic care-summary renderer (domain 11.5–11.7; plan 9C Task 3).
 *
 * It receives only facts the patient explicitly selected, each already read
 * from its exact current revision, and produces the snapshot content plus
 * its canonical SHA-256. It has no AI service, provider, location or
 * messaging dependency, never interprets a value, and keeps patient text
 * verbatim.
 *
 * care-summary-renderer.11c.1 (Packet 11C Addendum B, Task B1a, decision 5): after DATA_LIMITATIONS it stores the applicable
 * approved care-draft notices as CARE_DRAFT_NOTICE blocks in a CARE_DRAFT_NOTICES section, so the content hash covers them and
 * approval binds the exact artifact that contains them. The text comes only from the approved copy
 * (AI_LANGUAGE_COPY.careDraftNotices, through `careDraftNoticesFor`); nothing is sent anywhere.
 */

type Ref<T extends RecordType = RecordType> = TypedRevisionRef<T>;

export type CareSummaryDoseAmount = { value: string; unit: "MCG" | "MG" | "G" | "ML" | "UNIT" | "TABLET" | "CAPSULE" | "PUFF" | "DROP" | "PATCH" } | { value: string; unit: "OTHER"; otherUnitText: string };

export type CareSummaryFact =
  | { kind: "GLUCOSE"; ref: Ref<"GLUCOSE_READING">; occurrence: TimePoint; value: string }
  | {
      kind: "MEDICATION_EVENT";
      ref: Ref<"MEDICATION_EVENT">;
      occurrence: TimePoint;
      state: "TAKEN" | "MISSED" | "UNSURE" | "DECLINED_TO_RECORD";
      intendedAt: TimePoint | null;
      amount: CareSummaryDoseAmount | null;
      medication: { ref: Ref<"MEDICATION">; name: string };
    }
  | { kind: "INTAKE"; ref: Ref<"INTAKE_EVENT">; occurrence: TimePoint; intakeKind: string; items: string[] }
  | { kind: "ACTIVITY"; ref: Ref<"ACTIVITY_EVENT">; occurrence: TimePoint; label: string; minutes: number | null };

export type CareSummaryFactGroupKey = "GLUCOSE" | "INSULIN" | "MEALS" | "WALKS";

export type CareSummaryDraft = {
  locale: SupportedLocale;
  asOf: Instant;
  period: { startAt: Instant; endAtExclusive: Instant; startDate: string; endDate: string };
  appointment: { ref: Ref<"APPOINTMENT">; label: string; scheduledAt: TimePoint } | null;
  groups: Array<{ key: CareSummaryFactGroupKey; facts: CareSummaryFact[] }>;
  questions: Array<{ ref: Ref<"CARE_QUESTION">; text: string; language: "en-SG" | "zh-SG" | "und" }>;
  excluded: Array<{ source: Ref; reason: "NOT_SELECTED" | "PRIVATE_BY_DEFAULT" | "UNRELATED_TO_PURPOSE" | "INVALID_OR_SUPERSEDED" | "PATIENT_EXCLUDED" }>;
  replacesSnapshot?: Ref<"CARE_SUMMARY_SNAPSHOT">;
};

export type PreparedCareSummary = {
  payload: CareSummarySnapshotPayload;
  contentHash: Sha256Digest;
  sourceRevisions: Ref[];
};

const GROUP_ORDER: readonly CareSummaryFactGroupKey[] = ["GLUCOSE", "INSULIN", "MEALS", "WALKS"];
const GROUP_SECTION: Readonly<Record<CareSummaryFactGroupKey, CareSummarySectionId>> = { GLUCOSE: "MEASUREMENTS", INSULIN: "MEDICATION_RECORDS", MEALS: "INTAKE_AND_ACTIVITY", WALKS: "INTAKE_AND_ACTIVITY" };
const GROUP_BLOCK_ID: Readonly<Record<CareSummaryFactGroupKey, string>> = { GLUCOSE: "measurements.glucose", INSULIN: "medication.insulin", MEALS: "intake.meals", WALKS: "activity.walks" };

const refKey = (ref: Ref) => `${ref.recordType}|${ref.recordId}|${ref.revisionId}`;
const plainRef = <T extends RecordType>(ref: Ref<T>): Ref<T> => ({ recordType: ref.recordType, recordId: ref.recordId, revisionId: ref.revisionId });
const instantOf = (point: TimePoint): string => (point.kind === "EXACT" ? point.instantUtc : point.kind === "APPROXIMATE" ? point.approximateInstantUtc : point.kind === "DATE_ONLY" ? `${point.localDate}T00:00:00.000Z` : "");
const factTime = (fact: CareSummaryFact) => (fact.kind === "MEDICATION_EVENT" && fact.occurrence.kind === "UNKNOWN" && fact.intendedAt ? fact.intendedAt : fact.occurrence);

/** Stable display order: recorded time, then identity. */
function ordered(facts: CareSummaryFact[]): CareSummaryFact[] {
  return [...facts].sort((a, b) => instantOf(factTime(a)).localeCompare(instantOf(factTime(b))) || a.ref.recordId.localeCompare(b.ref.recordId));
}

function stateLabel(pack: CareSummaryLocalePack, state: "TAKEN" | "MISSED" | "UNSURE" | "DECLINED_TO_RECORD"): string {
  if (state === "TAKEN") return pack.schedule.recordedTaken;
  if (state === "MISSED") return pack.schedule.recordedSkipped;
  if (state === "UNSURE") return pack.schedule.recordedNotSure;
  return pack.schedule.recordedDeclined;
}

/** One block per selected group; every line is bound to exact source fields. */
function groupBlock(pack: CareSummaryLocalePack, key: CareSummaryFactGroupKey, facts: CareSummaryFact[]): { block: CareSummaryBlock; sources: Ref[] } {
  const blockId = GROUP_BLOCK_ID[key];
  const bindings: CareSummaryFactBinding[] = [];
  const sources: Ref[] = [];
  const lines: string[] = [];
  const addSource = (ref: Ref) => {
    if (!sources.some((existing) => refKey(existing) === refKey(ref))) sources.push(plainRef(ref));
  };
  ordered(facts).forEach((fact, index) => {
    const at = `${blockId}.${index + 1}`;
    addSource(fact.ref);
    const timeBinding = (source: Ref, value: TimePoint, field: "OCCURRENCE_TIME" | "PRESCRIPTION_INSTRUCTION", suffix: string): CareSummaryFactBinding => ({
      kind: "TIME_POINT",
      bindingKey: `${at}.${suffix}`,
      source: plainRef(source),
      sourceField: field,
      value,
    });
    if (fact.kind === "GLUCOSE") {
      bindings.push({ kind: "DECIMAL_VALUE", bindingKey: `${at}.value`, source: plainRef(fact.ref), sourceField: "MEASUREMENT_VALUE", value: fact.value as never, unit: { kind: "STANDARD", code: "MMOL_L" } });
      bindings.push(timeBinding(fact.ref, fact.occurrence, "OCCURRENCE_TIME", "time"));
      lines.push(`${pack.pointText(fact.occurrence)} · ${fact.value} ${pack.glucoseUnit}`);
    } else if (fact.kind === "MEDICATION_EVENT") {
      addSource(fact.medication.ref);
      bindings.push({ kind: "PATIENT_TEXT", bindingKey: `${at}.medicine`, source: plainRef(fact.medication.ref), sourceField: "MEDICATION_NAME", text: fact.medication.name, language: "und" });
      bindings.push({ kind: "CODED_VALUE", bindingKey: `${at}.state`, source: plainRef(fact.ref), sourceField: "MEDICATION_EVENT_STATE", code: fact.state, vocabularyVersion: "medication-event-state.6.7" });
      bindings.push(timeBinding(fact.ref, fact.occurrence, "OCCURRENCE_TIME", "time"));
      let line: string;
      if (fact.intendedAt) {
        // The scheduled occasion the patient recorded against, from the recorded directions.
        bindings.push(timeBinding(fact.ref, fact.intendedAt, "PRESCRIPTION_INSTRUCTION", "occasion"));
        const parts = pack.pointParts(fact.intendedAt);
        line = `${pack.schedule.recordOccasion(fact.medication.name, parts.date ?? pack.summary.timeNotRecorded, parts.time ?? pack.summary.timeNotRecorded)} · ${stateLabel(pack, fact.state)}`;
      } else {
        line = `${pack.pointText(fact.occurrence)} · ${fact.medication.name} · ${stateLabel(pack, fact.state)}`;
      }
      if (fact.amount) {
        bindings.push({
          kind: "DECIMAL_VALUE",
          bindingKey: `${at}.amount`,
          source: plainRef(fact.ref),
          sourceField: "DOSE_AMOUNT",
          value: fact.amount.value as never,
          unit: fact.amount.unit === "OTHER" ? { kind: "OTHER", exactUnitText: fact.amount.otherUnitText } : { kind: "STANDARD", code: fact.amount.unit },
        });
        const unitText = fact.amount.unit === "OTHER" ? fact.amount.otherUnitText : pack.schedule.unitLabels[fact.amount.unit];
        line += ` · ${pack.schedule.amountRecorded(fact.amount.value, unitText)}`;
      }
      lines.push(line);
    } else if (fact.kind === "INTAKE") {
      bindings.push(timeBinding(fact.ref, fact.occurrence, "OCCURRENCE_TIME", "time"));
      if (fact.items.length === 0) {
        bindings.push({ kind: "CODED_VALUE", bindingKey: `${at}.kind`, source: plainRef(fact.ref), sourceField: "INTAKE_KIND", code: fact.intakeKind, vocabularyVersion: "intake-kind.5.2" });
        lines.push(`${pack.pointText(fact.occurrence)} · ${pack.schedule.intakeRecord}`);
      } else {
        fact.items.forEach((item, itemIndex) => {
          bindings.push({ kind: "PATIENT_TEXT", bindingKey: `${at}.item.${itemIndex + 1}`, source: plainRef(fact.ref), sourceField: "INTAKE_LABEL", text: item, language: "und" });
        });
        lines.push(`${pack.pointText(fact.occurrence)} · ${fact.items.join(", ")}`);
      }
    } else {
      bindings.push(timeBinding(fact.ref, fact.occurrence, "OCCURRENCE_TIME", "time"));
      bindings.push({ kind: "PATIENT_TEXT", bindingKey: `${at}.label`, source: plainRef(fact.ref), sourceField: "ACTIVITY_LABEL", text: fact.label, language: "und" });
      let line = `${pack.pointText(fact.occurrence)} · ${fact.label}`;
      if (fact.minutes !== null) {
        bindings.push({ kind: "WHOLE_COUNT", bindingKey: `${at}.minutes`, source: plainRef(fact.ref), sourceField: "ACTIVITY_DURATION", value: fact.minutes });
        line += ` · ${pack.minutes(fact.minutes)}`;
      }
      lines.push(line);
    }
  });
  return {
    block: {
      kind: "RECORDED_FACT",
      blockId,
      temporalRole: "DURING_SELECTED_PERIOD",
      sourceRevisions: sources as [Ref, ...Ref[]],
      factBindings: bindings as [CareSummaryFactBinding, ...CareSummaryFactBinding[]],
      renderedText: [pack.groupTitles[key], ...lines].join("\n"),
    },
    sources,
  };
}

export async function renderDeterministicCareSummary(draft: CareSummaryDraft): Promise<PreparedCareSummary> {
  const pack = careSummaryLocalePack(draft.locale);
  const summary = pack.summary;
  const purpose: CareSummaryPurpose = draft.appointment ? { kind: "UPCOMING_APPOINTMENT", appointment: plainRef(draft.appointment.ref) } : { kind: "ROUTINE_REVIEW" };
  const selectedPeriod = { startAt: draft.period.startAt, endAtExclusive: draft.period.endAtExclusive };
  const included: Ref[] = [];
  const include = (ref: Ref) => {
    if (!included.some((existing) => refKey(existing) === refKey(ref))) included.push(plainRef(ref));
  };

  const range = `${pack.localDateText(draft.period.startDate)} – ${pack.localDateText(draft.period.endDate)}`;
  const asOfText = pack.pointText({ kind: "EXACT", instantUtc: draft.asOf, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });
  const scopeLines = [draft.appointment ? summary.purposeAppointment(draft.appointment.label) : summary.purposeRoutine, summary.periodLine(range), summary.preparedOn(asOfText)];

  const sections: Array<{ sectionId: CareSummaryPayloadSectionId; blocks: CareSummaryBlock[] }> = [
    {
      sectionId: "SUMMARY_SCOPE",
      blocks: [{ kind: "SUMMARY_SCOPE", blockId: "scope", temporalRole: "NOT_APPLICABLE", purpose, conditionScope: [], selectedPeriod, asOf: draft.asOf, localeAssetId: "care-summary.scope", renderedText: scopeLines.join("\n") }],
    },
  ];

  if (draft.appointment) {
    include(draft.appointment.ref);
    const appointment = draft.appointment;
    sections.push({
      sectionId: "CARE_ORGANISATION",
      blocks: [
        {
          kind: "RECORDED_FACT",
          blockId: "organisation.appointment",
          temporalRole: "CURRENT",
          sourceRevisions: [plainRef(appointment.ref)],
          factBindings: [
            { kind: "PATIENT_TEXT", bindingKey: "organisation.appointment.label", source: plainRef(appointment.ref), sourceField: "PATIENT_AUTHORED_TEXT", text: appointment.label, language: "und" },
            { kind: "TIME_POINT", bindingKey: "organisation.appointment.time", source: plainRef(appointment.ref), sourceField: "APPOINTMENT_TIME", value: appointment.scheduledAt },
          ],
          renderedText: [`${appointment.label} · ${pack.pointText(appointment.scheduledAt)}`, `${pack.appointmentEnteredByYou} · ${pack.appointmentUnverified}`].join("\n"),
        },
      ],
    });
  }

  for (const key of GROUP_ORDER) {
    const group = draft.groups.find((candidate) => candidate.key === key);
    if (!group || group.facts.length === 0) continue;
    const { block, sources } = groupBlock(pack, key, group.facts);
    sources.forEach(include);
    const sectionId = GROUP_SECTION[key];
    const existing = sections.find((section) => section.sectionId === sectionId);
    if (existing) existing.blocks.push(block);
    else sections.push({ sectionId, blocks: [block] });
  }

  if (draft.questions.length > 0) {
    sections.push({
      sectionId: "QUESTIONS_FOR_CARE_TEAM",
      blocks: draft.questions.map((question, index): CareSummaryBlock => {
        include(question.ref);
        // The patient's words and language exactly as recorded.
        return { kind: "PATIENT_QUESTION", blockId: `question.${index + 1}`, temporalRole: "CURRENT", question: plainRef(question.ref), originalPatientText: { text: question.text, language: question.language } };
      }),
    });
  }

  const limitationCodes = ["SELECTED_RECORDS_ONLY", "PATIENT_REPORTED_NOT_EXTERNALLY_VERIFIED", "MISSING_OR_UNRECORDED_DATA"] as const;
  const limitations = limitationCodes.map((code) => ({ code, relatedSources: [] as Ref[], blockId: `limitation.${code.toLowerCase().replaceAll("_", "-")}` }));
  sections.push({
    sectionId: "DATA_LIMITATIONS",
    blocks: limitations.map((limitation): CareSummaryBlock => {
      const assetId = limitationAssetId(limitation.code);
      return { kind: "SUMMARY_LIMITATION", blockId: limitation.blockId, temporalRole: "NOT_APPLICABLE", limitationCode: limitation.code, relatedSources: [], localeAssetId: assetId, renderedText: pack.asset(assetId) };
    }),
  });

  // The fixed care-draft notices, apart from the facts and the limitations: application wording with no source.
  const notices = careDraftNoticesFor(draft.locale, draft.questions.length > 0);
  sections.push({
    sectionId: "CARE_DRAFT_NOTICES",
    blocks: notices.map((notice): CareSummaryBlock => ({ kind: "CARE_DRAFT_NOTICE", blockId: `notice.${notice.kind.toLowerCase().replaceAll("_", "-")}`, temporalRole: "NOT_APPLICABLE", noticeKind: notice.kind, renderedText: notice.text })),
  });

  const orderedSections: CareSummarySection[] = sections.map((section, displayOrder) => ({
    sectionId: section.sectionId,
    titleLocaleAssetId: sectionAssetId(section.sectionId),
    displayOrder,
    blocks: section.blocks as [CareSummaryBlock, ...CareSummaryBlock[]],
  }));

  const includedKeys = new Set(included.map(refKey));
  const excluded = draft.excluded.filter((candidate, index, all) => !includedKeys.has(refKey(candidate.source)) && all.findIndex((other) => refKey(other.source) === refKey(candidate.source)) === index);

  const contentHash = await hashCanonicalJson(
    careSummaryExportProjection({
      purpose,
      conditionScope: [],
      selectedPeriod,
      asOf: draft.asOf,
      locale: draft.locale,
      sections: orderedSections,
      limitations,
      rendererVersion: CARE_SUMMARY_RENDERER_VERSION,
      localePackVersion: pack.version,
    }),
  );

  const candidate: CareSummarySnapshotPayload = {
    status: "PREPARED",
    purpose,
    conditionScope: [],
    selectedPeriod,
    asOf: draft.asOf,
    locale: draft.locale,
    selection: { includedSourceRevisions: included, excludedCandidates: excluded.map((entry) => ({ source: plainRef(entry.source), reason: entry.reason })) },
    sections: orderedSections as [CareSummarySection, ...CareSummarySection[]],
    limitations: limitations as [(typeof limitations)[number], ...(typeof limitations)[number][]],
    composition: { method: "DETERMINISTIC", templateVersion: CARE_SUMMARY_TEMPLATE_VERSION },
    rendering: { rendererVersion: CARE_SUMMARY_RENDERER_VERSION, localePackVersion: pack.version, contentHash },
    patientApproval: { state: "NOT_APPROVED" },
    ...(draft.replacesSnapshot ? { replacesSnapshot: plainRef(draft.replacesSnapshot) } : {}),
  };
  // The renderer fails closed: an invalid structure is never stored or shown.
  const payload = careSummarySnapshotPayloadSchema.parse(candidate) as CareSummarySnapshotPayload;
  return { payload, contentHash, sourceRevisions: included };
}

/**
 * care-summary-renderer.11c.2 / care-summary-template.11c.2 (Packet 11C Addendum C, Task C4): the AI-assisted replacement of the current
 * deterministic (11c.1) snapshot. `sections` are its content and notice sections exactly as the validated AI wording left them (only
 * recorded-fact wording differs; `projectValidatedAiCareSummary` checks that). This renderer appends the AI marking section (the
 * approved rows ai.demoTag then ai.resultCheck, in the snapshot locale; `careSummaryAiMarkingSection`) as the last section and hashes the
 * export projection with it and the 11c.2 renderer version, so approval binds the exact artifact that prints the marking. Everything
 * else (purpose, period, locale, selection, limitations, locale pack) is the current snapshot's. The result is unvalidated: the caller
 * parses it and checks the replacement invariant. Deterministic previews never pass through here and carry no marking.
 */
export async function renderAiAssistedCareSummary(input: {
  current: CareSummarySnapshotPayload;
  sections: CareSummarySnapshotPayload["sections"];
  aiInvocationAuditRef: string;
  validatedAt: Instant;
}): Promise<CareSummarySnapshotPayload> {
  const { current } = input;
  // The rows frozen for this template version (care-summary-ai-marking.ts), never read from the live catalogue.
  const sections = [...input.sections, careSummaryAiMarkingSection(current.locale, input.sections.length, CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION)] as CareSummarySnapshotPayload["sections"];
  const contentHash = await hashCanonicalJson(
    careSummaryExportProjection({ ...current, sections, rendererVersion: CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION, localePackVersion: current.rendering.localePackVersion }),
  );
  const { replacesSnapshot: _replaces, invalidation: _invalidation, ...rest } = current;
  return {
    ...rest,
    status: "PREPARED",
    sections,
    composition: { method: "AI_ASSISTED", templateVersion: CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION, aiInvocationAuditRef: input.aiInvocationAuditRef, validatedAt: input.validatedAt },
    rendering: { rendererVersion: CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION, localePackVersion: current.rendering.localePackVersion, contentHash },
    patientApproval: { state: "NOT_APPROVED" },
  };
}
