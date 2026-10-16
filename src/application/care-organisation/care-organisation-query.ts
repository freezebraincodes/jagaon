import type { Instant, RecordHead, RecordId } from "@/domain/shared";
import { timePointSchema, type TimePoint } from "@/domain/shared/temporal";
import type { PreventiveCareItemRevision } from "@/domain/care-plan/preventive-care";
import type { AppointmentRevision } from "@/domain/care-plan/appointment";
import type { CareQuestionRevision } from "@/domain/care-plan/care-question";
import type { PreventiveCareRecordRevision } from "@/domain/health-records/preventive-care-record";
import type { JagaOnDatabase } from "@/storage/database";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import { validatePacket6StoredRevision } from "@/application/journal/journal-row-codecs";
import { careOrganisationRevisionRowCodec } from "./care-organisation-persistence";
import {
  FACT_GROUP_KEYS,
  type AppointmentView,
  type CareOrganisationQueryPort,
  type CareQuestionView,
  type FactGroupView,
  type PreventiveCareItemView,
  type PreventiveCareView,
  type PreventiveHistoryEntry,
  type ReportedPreventiveCompletion,
  type VisitPreparationView,
} from "./care-organisation-contracts";

/**
 * Packet 9B read projections for Screens 09 and 10. They relay recorded
 * values only: a status is "scheduled" because the patient entered a date,
 * "recorded" because the patient reported an occurrence, and "no date"
 * otherwise. Nothing here computes eligibility, due, overdue, attendance or
 * completion, and a missing record stays missing.
 */

export type {
  PreventiveCareStatus,
  PreventiveHistoryEntry,
  PreventiveCareItemView,
  PreventiveCareView,
  ReportedPreventiveCompletion,
  AppointmentView,
  CareQuestionView,
  FactGroupKey,
  FactGroupView,
  VisitPreparationView,
  CareOrganisationQueryPort,
} from "./care-organisation-contracts";
export { FACT_GROUP_KEYS } from "./care-organisation-contracts";

const FACT_GROUP_RECORD_TYPE = Object.freeze({ GLUCOSE: "GLUCOSE_READING", INSULIN: "MEDICATION_EVENT", MEALS: "INTAKE_EVENT", WALKS: "ACTIVITY_EVENT" } as const);

const HOME_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/**
 * Ordinary preparation period: the 5 local days ending today (within the 180-day maximum). Owner instruction 2026-10-12: was 30, then
 * 14, so an ordinary visit summary's readings fit what one care-summary wording request may carry. Owner decision 2026-10-16: 5 days, so
 * three readings a day (the fuller demo history) still fit the AI wording (about 16 readings with the appointment and one question).
 */
export const VISIT_PREPARATION_PERIOD_DAYS = 5;

const localDateOf = (instant: string) => new Date(Date.parse(instant) + HOME_OFFSET_MS).toISOString().slice(0, 10);
const localMidnightUtc = (localDate: string) => new Date(Date.parse(`${localDate}T00:00:00.000Z`) - HOME_OFFSET_MS).toISOString() as Instant;

/** The recorded intended-occasion time of a medication record, when it names one. */
function intendedOccasionInstant(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("intendedOccasion" in payload)) return null;
  const occasion = payload.intendedOccasion;
  if (typeof occasion !== "object" || occasion === null || !("expectedAt" in occasion)) return null;
  const parsed = timePointSchema.safeParse(occasion.expectedAt);
  return parsed.success ? instantOf(parsed.data) : null;
}

/** A sortable instant for a time point; unknown stays null. */
function instantOf(point: TimePoint): string | null {
  if (point.kind === "EXACT") return point.instantUtc;
  if (point.kind === "APPROXIMATE") return point.approximateInstantUtc;
  if (point.kind === "DATE_ONLY") return localMidnightUtc(point.localDate);
  return null;
}

export function createCareOrganisationQuery(database: JagaOnDatabase, dependencies: { now: () => Instant }): CareOrganisationQueryPort {
  async function activeHeads(recordType: string): Promise<RecordHead[]> {
    const heads = (await database.table("recordHeads").where("recordType").equals(recordType).toArray()) as RecordHead[];
    return heads.filter((head) => head.state === "ACTIVE");
  }

  async function carePlanHead<T>(head: RecordHead): Promise<T> {
    return carePlanRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as T;
  }

  async function chain<T>(recordId: RecordId, codec: { validateAfterRead(value: unknown): { revision: unknown } }): Promise<T[]> {
    const rows = await database.table("recordRevisions").where("recordId").equals(recordId).toArray();
    return rows.map((row) => codec.validateAfterRead(row).revision as T).sort((a, b) => (a as { revisionNumber: number }).revisionNumber - (b as { revisionNumber: number }).revisionNumber);
  }

  async function loadPreventiveCare(): Promise<PreventiveCareView> {
    try {
      const recordsByItem = new Map<string, PreventiveCareRecordRevision[]>();
      const recordChains = new Map<string, PreventiveCareRecordRevision[]>();
      const completedRecords: PreventiveCareRecordRevision[] = [];
      for (const head of await activeHeads("PREVENTIVE_CARE_RECORD")) {
        const revisions = await chain<PreventiveCareRecordRevision>(head.recordId, careOrganisationRevisionRowCodec);
        const current = revisions.find((revision) => revision.revisionId === head.headRevisionId)!;
        if (current.payload.completionReport.kind === "PATIENT_REPORTED_COMPLETED") completedRecords.push(current);
        if (current.payload.careReference.kind !== "PLANNED_ITEM") continue;
        const itemId = current.payload.careReference.item.recordId;
        recordsByItem.set(itemId, [...(recordsByItem.get(itemId) ?? []), current]);
        recordChains.set(head.recordId, revisions);
      }
      const items: PreventiveCareItemView[] = [];
      const itemIdentities = new Map<string, PreventiveCareItemRevision["payload"]["identity"]>();
      for (const head of await activeHeads("PREVENTIVE_CARE_ITEM")) {
        const revisions = await chain<PreventiveCareItemRevision>(head.recordId, carePlanRevisionRowCodec);
        const current = revisions.find((revision) => revision.revisionId === head.headRevisionId)!;
        itemIdentities.set(head.recordId, current.payload.identity);
        if (current.payload.trackingState === "ENDED") continue;
        // A report counts for the plan it was made against: later corrections keep
        // that plan, but a superseding new plan starts without any report.
        const planStillCurrent = (revisionId: string) => {
          const index = revisions.findIndex((revision) => revision.revisionId === revisionId);
          return index >= 0 && revisions.slice(index + 1).every((revision) => revision.action === "CORRECT");
        };
        const reports = (recordsByItem.get(head.recordId) ?? [])
          .filter((record) => record.payload.careReference.kind === "PLANNED_ITEM" && planStillCurrent(record.payload.careReference.item.revisionId))
          .filter((record) => record.payload.completionReport.kind === "PATIENT_REPORTED_COMPLETED")
          .sort((a, b) => (instantOf(b.temporal.occurrence) ?? "").localeCompare(instantOf(a.temporal.occurrence) ?? "") || b.recordedAt.localeCompare(a.recordedAt));
        const latest = reports[0] ?? null;
        const schedule = current.payload.schedule;
        const target = schedule.kind === "TARGET_DATE" ? schedule.targetDate : schedule.kind === "RECURRING_REPORTED_PLAN" ? (schedule.nextTargetDate ?? null) : null;
        const latestHead = latest ? ((await database.table("recordHeads").get(latest.recordId)) as RecordHead) : null;
        const history: PreventiveHistoryEntry[] = [
          ...revisions.map((revision): PreventiveHistoryEntry => {
            const s = revision.payload.schedule;
            const date = s.kind === "TARGET_DATE" ? s.targetDate : s.kind === "RECURRING_REPORTED_PLAN" ? (s.nextTargetDate ?? null) : null;
            return { kind: "ITEM", action: revision.action, revisionCreatedAt: revision.revisionCreatedAt, dateEntered: date ? { kind: "TARGET", localDate: date } : null, note: revision.payload.patientNote ?? null };
          }),
          ...(recordsByItem.get(head.recordId) ?? []).flatMap((record) =>
            (recordChains.get(record.recordId) ?? []).map((revision): PreventiveHistoryEntry => ({
              kind: "RECORD",
              action: revision.action,
              revisionCreatedAt: revision.revisionCreatedAt,
              dateEntered: { kind: "OCCURRENCE", occurrence: revision.temporal.occurrence },
              note: revision.payload.patientNote ?? null,
            })),
          ),
        ].sort((a, b) => a.revisionCreatedAt.localeCompare(b.revisionCreatedAt));
        items.push({
          recordId: current.recordId,
          revisionId: current.revisionId,
          revisionNumber: current.revisionNumber,
          payload: current.payload,
          status: latest ? "RECORDED" : target ? "SCHEDULED" : "NO_DATE",
          dateEntered: latest ? { kind: "OCCURRENCE", occurrence: latest.temporal.occurrence } : target ? { kind: "TARGET", localDate: target } : null,
          currentRecord: latest && latestHead ? { recordId: latest.recordId, revisionId: latest.revisionId, revisionNumber: latestHead.headRevisionNumber, occurrence: latest.temporal.occurrence } : null,
          history,
        });
      }
      // Entry order: first recorded first; ties broken by identity for determinism.
      const firstRecorded = new Map(items.map((item) => [item.recordId, item.history.find((entry) => entry.kind === "ITEM")?.revisionCreatedAt ?? ""]));
      items.sort((a, b) => firstRecorded.get(a.recordId)!.localeCompare(firstRecorded.get(b.recordId)!) || a.recordId.localeCompare(b.recordId));
      // Every reported completion by catalogue key, whatever plan it was made against (or none); an unknown date is left out.
      const reportedCompletions: ReportedPreventiveCompletion[] = [];
      for (const record of completedRecords) {
        const reference = record.payload.careReference;
        const identity = reference.kind === "UNPLANNED" ? reference.identity : itemIdentities.get(reference.item.recordId);
        const at = instantOf(record.temporal.occurrence);
        if (!identity || identity.kind !== "REVIEWED_CATALOGUE_MATCH" || at === null) continue;
        const localDate = record.temporal.occurrence.kind === "DATE_ONLY" ? record.temporal.occurrence.localDate : localDateOf(at);
        reportedCompletions.push({ catalogueEntryKey: identity.catalogueEntryKey, localDate });
      }
      reportedCompletions.sort((a, b) => a.catalogueEntryKey.localeCompare(b.catalogueEntryKey) || a.localDate.localeCompare(b.localDate));
      return { status: "READY", items, reportedCompletions };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }

  async function loadVisitPreparation(): Promise<VisitPreparationView> {
    try {
      const now = dependencies.now();
      const today = localDateOf(now);
      const startDate = localDateOf(new Date(Date.parse(`${today}T00:00:00.000Z`) - (VISIT_PREPARATION_PERIOD_DAYS - 1) * DAY_MS).toISOString());
      const period = {
        startAt: localMidnightUtc(startDate),
        endAtExclusive: localMidnightUtc(localDateOf(new Date(Date.parse(`${today}T00:00:00.000Z`) + DAY_MS).toISOString())),
        startDate,
        endDate: today,
      };

      // The next scheduled appointment the patient recorded from today onward.
      const appointments: AppointmentView[] = [];
      for (const head of await activeHeads("APPOINTMENT")) {
        const revision = await carePlanHead<AppointmentRevision>(head);
        if (revision.payload.status !== "SCHEDULED") continue;
        const at = instantOf(revision.temporal.occurrence);
        if (at === null || at < localMidnightUtc(today)) continue;
        appointments.push({ recordId: revision.recordId, revisionId: revision.revisionId, revisionNumber: revision.revisionNumber, payload: revision.payload, scheduledAt: revision.temporal.occurrence });
      }
      appointments.sort((a, b) => instantOf(a.scheduledAt)!.localeCompare(instantOf(b.scheduledAt)!) || a.recordId.localeCompare(b.recordId));

      const questions: Array<CareQuestionView & { firstRecordedAt: string }> = [];
      for (const head of await activeHeads("CARE_QUESTION")) {
        const revision = await carePlanHead<CareQuestionRevision>(head);
        if (revision.payload.state !== "READY_TO_ASK" || revision.payload.origin.kind !== "PATIENT_AUTHORED") continue;
        const first = (await chain<CareQuestionRevision>(head.recordId, carePlanRevisionRowCodec))[0]!;
        questions.push({
          firstRecordedAt: first.revisionCreatedAt,
          recordId: revision.recordId,
          revisionId: revision.revisionId,
          revisionNumber: revision.revisionNumber,
          text: revision.payload.questionText.text,
          language: revision.payload.questionText.language,
          relatedAppointment: revision.payload.relatedAppointment?.recordId ?? null,
        });
      }
      // Entry order, so a newly added question appears last.
      questions.sort((a, b) => a.firstRecordedAt.localeCompare(b.firstRecordedAt) || a.recordId.localeCompare(b.recordId));

      const factGroups: FactGroupView[] = [];
      for (const key of FACT_GROUP_KEYS) {
        const recordType = FACT_GROUP_RECORD_TYPE[key];
        const sources: Array<{ ref: FactGroupView["sources"][number]; at: string }> = [];
        for (const head of await activeHeads(recordType)) {
          const stored = validatePacket6StoredRevision(await database.table("recordRevisions").get(head.headRevisionId));
          const temporal = stored.revision.temporal as { kind: string; occurrence?: TimePoint; start?: TimePoint };
          const point = temporal.kind === "POINT" ? temporal.occurrence! : temporal.kind === "INTERVAL" ? temporal.start! : { kind: "UNKNOWN" as const };
          // A medication record with no known time is placed by the occasion the patient recorded it for.
          const at = instantOf(point) ?? (recordType === "MEDICATION_EVENT" ? intendedOccasionInstant(stored.revision.payload) : null);
          // An unknown occurrence cannot be placed inside the period, so it is not listed.
          if (at === null || at < period.startAt || at >= period.endAtExclusive) continue;
          sources.push({ ref: { recordType, recordId: head.recordId, revisionId: head.headRevisionId } as FactGroupView["sources"][number], at });
        }
        sources.sort((a, b) => a.at.localeCompare(b.at) || a.ref.recordId.localeCompare(b.ref.recordId));
        factGroups.push({ key, sources: sources.map((entry) => entry.ref) });
      }

      return { status: "READY", appointment: appointments[0] ?? null, questions: questions.map(({ firstRecordedAt: _entryOrder, ...question }) => question), period, factGroups };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }

  return Object.freeze({ loadPreventiveCare, loadVisitPreparation });
}
