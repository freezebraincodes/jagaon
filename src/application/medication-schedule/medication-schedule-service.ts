import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { Instant, RecordHead, RecordId, RevisionId } from "@/domain/shared";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { MedicationRevision, PrescriptionVersionRevision } from "@/domain/care-plan/care-plan-revisions";
import type { ReminderPayload, ReminderRevision } from "@/domain/care-plan/reminder";
import type { CareQuestionRevision } from "@/domain/care-plan/care-question";
import type { DoseAmount } from "@/domain/care-plan/dose";
import { enabledInquiryDefinitions, type InquiryRawAnswer, type InquiryResponseRevision, type InquiryRevision } from "@/domain/inquiry";
import { INQUIRY_CAPABILITY_MANIFEST } from "@/inquiry/inquiry-capability-manifest";
import { exactOccasionOf, localDateInOffset, occasionIdentity } from "@/inquiry/medication-occasion-barrier";
import type { JagaOnDatabase } from "@/storage/database";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import { medicationEventRevisionCodec, type MedicationEventRevision } from "@/application/journal/journal-row-codecs";
import type { MedicationEventCommands } from "@/application/journal/journal-contracts";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import type { CarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { inquiryOwnedRevisionRowCodec } from "@/application/inquiry/inquiry-persistence";
import type { InquiryService } from "@/application/inquiry/inquiry-service";
import { projectBarrierCounts, type CountableResponseInput } from "./barrier-counts";
import type {
  MedicationSchedulePort,
  MedicationScheduleView,
  RecordOccasionInput,
  SaveRecordResult,
  ScheduleActionResult,
  ScheduleAmount,
  ScheduleAmountUnit,
  ScheduleBarrierView,
  ScheduleOccasionView,
  ScheduleRecordedState,
  ScheduleReminderView,
} from "./medication-schedule-contracts";

/**
 * Packet 8 Medication schedule application service (Packet 8 design
 * Sections 4–5; LRJ-003).
 *
 * The schedule shows only fixed local times relayed from current recorded
 * prescription revisions. As-needed, continuous, event-relative, frequency-
 * only and unstructured directions never become a clock time. An occasion
 * without a matching explicit record is only "Not recorded"; it creates no
 * medication event, question, answer, barrier or adherence fact.
 */

const DAY_MS = 86_400_000;
const OFFSET_MINUTES = INQUIRY_CAPABILITY_MANIFEST.medicationOccasionBarrier.homeUtcOffsetMinutes;
const TIME_ZONE = INQUIRY_CAPABILITY_MANIFEST.medicationOccasionBarrier.homeTimeZoneId;
const WINDOW_DAYS = INQUIRY_CAPABILITY_MANIFEST.medicationOccasionBarrier.factualCountWindowDays;
const ALL_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

const STATE_BY_UI: Readonly<Record<ScheduleRecordedState, MedicationEventPayload["state"]>> = Object.freeze({
  TAKEN: "TAKEN",
  SKIPPED: "MISSED",
  NOT_SURE: "UNSURE",
  DECLINED: "DECLINED_TO_RECORD",
});

function uiState(state: MedicationEventPayload["state"]): ScheduleRecordedState | null {
  if (state === "TAKEN") return "TAKEN";
  if (state === "MISSED") return "SKIPPED";
  if (state === "UNSURE") return "NOT_SURE";
  if (state === "DECLINED_TO_RECORD") return "DECLINED";
  return null;
}

function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The exact instant of a recorded local clock time on a local date in the home timezone. */
function occasionInstant(localDate: string, time: string): Instant {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hours, minutes) - OFFSET_MINUTES * 60_000).toISOString() as Instant;
}

/** The unit a patient-entered amount may use, relayed from the recorded dose instruction; never a value. */
function amountUnitOf(prescription: PrescriptionVersionRevision): ScheduleAmountUnit | null {
  const instruction = prescription.payload.doseInstruction;
  const amounts: DoseAmount[] =
    instruction.kind === "FIXED" ? [instruction.amount] : instruction.kind === "VARIABLE_PER_REPORTED_PLAN" ? instruction.reportedAmounts : [];
  if (amounts.length === 0) return null;
  const first = amounts[0]!;
  const otherText = (amount: DoseAmount) => ("otherUnitText" in amount ? amount.otherUnitText : null);
  if (amounts.some((amount) => amount.unit !== first.unit || otherText(amount) !== otherText(first))) return null;
  return { unit: first.unit, otherUnitText: otherText(first) };
}

function scheduleAmount(payload: MedicationEventPayload): ScheduleAmount | null {
  if (payload.state !== "TAKEN") return null;
  const taken = payload.amountTaken;
  if (taken.kind !== "KNOWN") return { kind: taken.kind };
  return { kind: "KNOWN", value: taken.amount.value, unit: taken.amount.unit, otherUnitText: "otherUnitText" in taken.amount ? taken.amount.otherUnitText : null };
}

export function createMedicationScheduleService(
  database: JagaOnDatabase,
  dependencies: {
    now: () => Instant;
    journal: MedicationEventCommands;
    carePlan: CarePlanCommandService;
    inquiry: InquiryService;
    /** Runs queued Inquiry eligibility and reminder reconciliation after a commit. */
    settle: () => Promise<void>;
  },
): MedicationSchedulePort {
  async function activeHeads(recordType: string): Promise<RecordHead[]> {
    const heads = (await database.table("recordHeads").where("recordType").equals(recordType).toArray()) as RecordHead[];
    return heads.filter((head) => head.state === "ACTIVE").sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
  }

  async function carePlanRevision<T>(revisionId: string): Promise<T> {
    return carePlanRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(revisionId)).revision as T;
  }

  async function eventRevision(revisionId: string): Promise<MedicationEventRevision | null> {
    const raw = await database.table("recordRevisions").get(revisionId);
    return raw === undefined ? null : medicationEventRevisionCodec.validateAfterRead(raw).revision;
  }

  async function inquiryChainHead(recordId: string): Promise<InquiryRevision | null> {
    const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
    if (!head || head.state !== "ACTIVE") return null;
    return inquiryOwnedRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as InquiryRevision;
  }

  async function responseRevision(recordId: string): Promise<{ head: RecordHead; revision: InquiryResponseRevision } | null> {
    const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
    if (!head || head.state !== "ACTIVE") return null;
    const revision = inquiryOwnedRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as InquiryResponseRevision;
    return { head, revision };
  }

  function answerView(raw: InquiryRawAnswer): Extract<ScheduleBarrierView, { kind: "ANSWERED" }>["answer"] {
    if (raw.kind === "BOUNDED_CHOICE") return { kind: "OPTION", optionKey: raw.optionKey as never };
    if (raw.kind === "SOMETHING_ELSE") return { kind: "SOMETHING_ELSE", text: raw.text.text };
    if (raw.kind === "PREFER_NOT_TO_SAY") return { kind: "PREFER_NOT_TO_SAY" };
    return { kind: "NOT_SURE" };
  }

  async function barrierFor(event: MedicationEventRevision, now: Instant): Promise<ScheduleBarrierView> {
    if (event.payload.state !== "MISSED" && event.payload.state !== "UNSURE") return { kind: "NONE" };
    const edges = (await database.table("reverseDependencies").where("sourceRevisionId").equals(event.revisionId).toArray()) as StoredReverseDependency[];
    for (const edge of edges.filter((entry) => entry.owner === "INQUIRY")) {
      const inquiry = await inquiryChainHead(edge.dependentRecordId);
      if (!inquiry) continue;
      const lifecycle = inquiry.payload.lifecycle;
      if (lifecycle.state === "ANSWERED" || lifecycle.state === "NOT_SURE" || lifecycle.state === "DECLINED") {
        const response = await responseRevision(lifecycle.response.recordId);
        if (response) return { kind: "ANSWERED", responseRecordId: response.head.recordId, answer: answerView(response.revision.payload.rawAnswer) };
      }
      if (lifecycle.state === "ELIGIBLE" || lifecycle.state === "QUEUED" || lifecycle.state === "PRESENTED") return { kind: "OFFER_AVAILABLE" };
      if (lifecycle.state === "SNOOZED" && Date.parse(now) >= Date.parse(lifecycle.eligibleAgainAt)) return { kind: "OFFER_AVAILABLE" };
    }
    return { kind: "NONE" };
  }

  async function countableResponses(medicineNames: Map<string, string>): Promise<CountableResponseInput[]> {
    const result: CountableResponseInput[] = [];
    for (const head of await activeHeads("INQUIRY_RESPONSE")) {
      const response = (await responseRevision(head.recordId))!;
      const presentedRef = response.revision.payload.inquiryPresentation.inquiry;
      const presentedRaw = await database.table("recordRevisions").get(presentedRef.revisionId);
      const inquiryHead = await inquiryChainHead(presentedRef.recordId);
      if (presentedRaw === undefined || !inquiryHead) continue;
      const presented = inquiryOwnedRevisionRowCodec.validateAfterRead(presentedRaw).revision as InquiryRevision;
      const basis = presented.payload.basis.purpose === "RECORD_CLARIFICATION" ? presented.payload.basis.records[0] : null;
      if (!basis || basis.recordType !== "MEDICATION_EVENT") continue;
      const event = await eventRevision(basis.revisionId);
      const occasion = event ? exactOccasionOf(event.payload, OFFSET_MINUTES) : null;
      if (!event || !occasion) continue;
      const lifecycle = inquiryHead.payload.lifecycle;
      const answersCurrent =
        (lifecycle.state === "ANSWERED" || lifecycle.state === "NOT_SURE" || lifecycle.state === "DECLINED") &&
        lifecycle.response.revisionId === response.revision.revisionId;
      const raw = response.revision.payload.rawAnswer;
      result.push({
        responseRecordId: head.recordId,
        rawAnswerKind: raw.kind,
        optionKey: raw.kind === "BOUNDED_CHOICE" ? (raw.optionKey as never) : null,
        inquiryAnswersCurrentRevision: answersCurrent,
        basisRevisionId: basis.revisionId,
        basisRecordId: basis.recordId,
        occasion: {
          identity: occasionIdentity(occasion),
          localDate: occasion.localDate,
          scheduledTime: localTimeOf(occasion.expectedAt),
          medicineName: medicineNames.get(event.payload.medication.recordId) ?? "",
        },
      });
    }
    return result;
  }

  function localTimeOf(instant: string): string {
    return new Date(Date.parse(instant) + OFFSET_MINUTES * 60_000).toISOString().slice(11, 16);
  }

  async function load(request: { locale: SupportedLocale; medicationRecordIds: readonly string[] }): Promise<MedicationScheduleView> {
    try {
      await dependencies.inquiry.maintain();
      const now = dependencies.now();
      const today = localDateInOffset(now, OFFSET_MINUTES);
      const yesterday = shiftDate(today, -1);
      const window = { startDate: shiftDate(today, -(WINDOW_DAYS - 1)), endDate: today };
      const inScope = new Set(request.medicationRecordIds);

      const medicines = new Map<string, string>();
      for (const head of await activeHeads("MEDICATION")) {
        const medication = await carePlanRevision<MedicationRevision>(head.headRevisionId);
        medicines.set(head.recordId, medication.payload.identity.patientEnteredName);
      }

      // Current explicit records, keyed by their exact recorded occasion.
      const recordsByOccasion = new Map<string, MedicationEventRevision>();
      const eventHeads: { recordId: string; headRevisionId: string; state: string; active: boolean }[] = [];
      for (const head of (await database.table("recordHeads").where("recordType").equals("MEDICATION_EVENT").toArray()) as RecordHead[]) {
        const event = head.state === "ACTIVE" ? await eventRevision(head.headRevisionId) : null;
        eventHeads.push({ recordId: head.recordId, headRevisionId: head.headRevisionId, state: event?.payload.state ?? "DELETED", active: head.state === "ACTIVE" });
        if (!event) continue;
        const occasion = exactOccasionOf(event.payload, OFFSET_MINUTES);
        if (!occasion) continue;
        const key = occasionIdentity(occasion);
        const existing = recordsByOccasion.get(key);
        if (!existing || existing.recordedAt < event.recordedAt) recordsByOccasion.set(key, event);
      }

      const occasions: ScheduleOccasionView[] = [];
      const withoutFixedTime: { medicineName: string }[] = [];
      let unrecordedCount = 0;
      const prescriptions = (await Promise.all((await activeHeads("PRESCRIPTION_VERSION")).map((head) => carePlanRevision<PrescriptionVersionRevision>(head.headRevisionId))))
        .filter((revision) => inScope.has(revision.payload.medication.recordId))
        .sort((a, b) => (medicines.get(a.payload.medication.recordId) ?? "").localeCompare(medicines.get(b.payload.medication.recordId) ?? ""));

      for (const prescription of prescriptions) {
        const medicineName = medicines.get(prescription.payload.medication.recordId) ?? "";
        const schedule = prescription.payload.schedule;
        if (schedule.kind !== "FIXED_LOCAL_TIMES") {
          withoutFixedTime.push({ medicineName });
          continue;
        }
        const start = prescription.payload.effectivePeriod.start;
        const startDate = start.kind === "DATE_ONLY" ? start.localDate : start.kind === "EXACT" ? localDateInOffset(start.instantUtc, OFFSET_MINUTES) : null;
        const prescriptionRef = { recordId: prescription.recordId, revisionId: prescription.revisionId };
        const sourceDate = startDate ?? localDateInOffset(prescription.recordedAt, OFFSET_MINUTES);
        for (const entry of schedule.entries) {
          // Missingness is counted only for dates the recorded schedule covers.
          if (startDate !== null) {
            for (let date = window.startDate; date <= window.endDate; date = shiftDate(date, 1)) {
              if (date < startDate || Date.parse(occasionInstant(date, entry.time)) > Date.parse(now)) continue;
              if (!recordsByOccasion.has(occasionIdentity({ prescription: { ...prescriptionRef, recordType: "PRESCRIPTION_VERSION" } as never, scheduleKey: entry.scheduleKey, localDate: date }))) {
                unrecordedCount += 1;
              }
            }
          }
          for (const [section, date] of [["YESTERDAY", yesterday], ["TODAY", today]] as const) {
            const key = occasionIdentity({ prescription: { ...prescriptionRef, recordType: "PRESCRIPTION_VERSION" } as never, scheduleKey: entry.scheduleKey, localDate: date });
            const event = recordsByOccasion.get(key) ?? null;
            const state = event ? uiState(event.payload.state) : null;
            const eventHead = event ? (await database.table("recordHeads").get(event.recordId)) as RecordHead : null;
            occasions.push({
              occasionId: key,
              section,
              localDate: date,
              scheduledTime: entry.time,
              medicineName,
              scheduleSource: { kind: "SYNTHETIC_DEMO", date: sourceDate },
              occasion: {
                medication: { recordId: prescription.payload.medication.recordId, revisionId: prescription.payload.medication.revisionId },
                prescription: prescriptionRef,
                scheduleKey: entry.scheduleKey,
                expectedAt: occasionInstant(date, entry.time),
              },
              amountUnit: amountUnitOf(prescription),
              record:
                event && state && eventHead
                  ? { recordId: event.recordId, revisionId: event.revisionId, revisionNumber: eventHead.headRevisionNumber, state, amount: scheduleAmount(event.payload), recordedAt: event.recordedAt }
                  : null,
              barrier: event ? await barrierFor(event, now) : { kind: "NONE" },
            });
          }
        }
      }
      occasions.sort((a, b) => (a.section === b.section ? (a.scheduledTime === b.scheduledTime ? a.medicineName.localeCompare(b.medicineName) : a.scheduledTime < b.scheduledTime ? -1 : 1) : a.section === "YESTERDAY" ? -1 : 1));

      const { counts, excludedCorrected } = projectBarrierCounts({
        responses: await countableResponses(medicines),
        eventHeads,
        window,
        optionOrder: enabledInquiryDefinitions()[0]!.answerContract.optionKeys,
      });

      const reminders: ScheduleReminderView[] = [];
      for (const head of await activeHeads("REMINDER")) {
        const reminder = await carePlanRevision<ReminderRevision>(head.headRevisionId);
        const payload = reminder.payload;
        if (payload.state === "ENDED" || payload.schedule.kind !== "WEEKLY_LOCAL") continue;
        if (payload.subject.kind !== "MEDICATION" && payload.subject.kind !== "MEASUREMENT" && payload.subject.kind !== "CUSTOM") continue;
        let currentPrescription: ScheduleReminderView["currentPrescription"] = null;
        if (payload.subject.kind === "MEDICATION") {
          const target = (await database.table("recordHeads").get(payload.subject.target.recordId)) as RecordHead | undefined;
          if (target?.state === "ACTIVE") {
            const current = await carePlanRevision<PrescriptionVersionRevision>(target.headRevisionId);
            currentPrescription = {
              recordId: current.recordId,
              revisionId: current.revisionId,
              times: current.payload.schedule.kind === "FIXED_LOCAL_TIMES" ? current.payload.schedule.entries.map((entry) => entry.time) : [],
            };
          }
        }
        reminders.push({
          recordId: reminder.recordId,
          revisionId: reminder.revisionId,
          revisionNumber: reminder.revisionNumber,
          label: payload.label.text,
          state: payload.state,
          daysOfWeek: [...payload.schedule.daysOfWeek],
          times: [...payload.schedule.times],
          subject: payload.subject.kind,
          currentPrescription,
        });
      }
      reminders.sort((a, b) => (a.times[0] ?? "").localeCompare(b.times[0] ?? "") || a.label.localeCompare(b.label));

      const careQuestions = [];
      for (const head of await activeHeads("CARE_QUESTION")) {
        const question = await carePlanRevision<CareQuestionRevision>(head.headRevisionId);
        if (question.payload.state !== "READY_TO_ASK" && question.payload.state !== "DRAFT") continue;
        careQuestions.push({
          recordId: question.recordId,
          revisionId: question.revisionId,
          revisionNumber: question.revisionNumber,
          text: question.payload.questionText.text,
          language: question.payload.questionText.language,
        });
      }

      return {
        status: "READY",
        today,
        yesterday,
        occasions,
        withoutFixedTime,
        window,
        counts,
        excludedCorrected,
        unrecordedCount,
        reminders,
        careQuestions,
      };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }

  function eventPayload(input: RecordOccasionInput): MedicationEventPayload | null {
    const prescriptionVersion = { recordType: "PRESCRIPTION_VERSION" as const, ...input.occasion.prescription };
    const base = {
      medication: { recordType: "MEDICATION" as const, ...input.occasion.medication },
      prescriptionVersion,
      intendedOccasion: {
        expectedAt: { kind: "EXACT" as const, instantUtc: input.occasion.expectedAt, timeZoneId: TIME_ZONE, utcOffsetMinutes: OFFSET_MINUTES },
        prescriptionVersion,
        scheduleKey: input.occasion.scheduleKey,
      },
    };
    const state = STATE_BY_UI[input.state];
    if (state !== "TAKEN") return input.amount === null ? ({ ...base, state } as MedicationEventPayload) : null;
    const amount = input.amount;
    if (!amount) return null;
    // Only what the patient entered or chose; JagaOn never fills, compares or corrects it.
    const amountTaken =
      amount.kind === "KNOWN"
        ? { kind: "KNOWN" as const, amount: (amount.unit === "OTHER" ? { value: amount.value, unit: "OTHER", otherUnitText: amount.otherUnitText ?? "" } : { value: amount.value, unit: amount.unit }) as DoseAmount }
        : { kind: amount.kind };
    return { ...base, state: "TAKEN", amountTaken } as MedicationEventPayload;
  }

  async function afterSave(recordId: RecordId, state: ScheduleRecordedState, locale: SupportedLocale): Promise<SaveRecordResult> {
    await dependencies.settle();
    if (state !== "SKIPPED" && state !== "NOT_SURE") return { kind: "SAVED", medicationEventRecordId: recordId, offer: null };
    const offer = await dependencies.inquiry.offerForMedicationEvent(recordId, locale);
    return { kind: "SAVED", medicationEventRecordId: recordId, offer: offer.kind === "PRESENTED" ? offer.question : null };
  }

  function failure(code: string): SaveRecordResult {
    return { kind: "FAILED", code: code === "HEAD_CONFLICT" ? "HEAD_CONFLICT" : code === "VALIDATION_FAILED" ? "VALIDATION_FAILED" : "STORAGE_UNAVAILABLE" };
  }

  function rawAnswerOf(answer: Parameters<MedicationSchedulePort["answerBarrier"]>[0]["answer"]): InquiryRawAnswer {
    if (answer.kind === "OPTION") return { kind: "BOUNDED_CHOICE", optionKey: answer.optionKey } as InquiryRawAnswer;
    if (answer.kind === "SOMETHING_ELSE") return { kind: "SOMETHING_ELSE", text: { text: answer.text, language: answer.language } };
    return { kind: answer.kind };
  }

  function actionResult(result: { kind: string; code?: string }): ScheduleActionResult {
    return result.kind === "COMMITTED" ? { kind: "SAVED" } : { kind: "FAILED", code: result.code ?? result.kind };
  }

  async function currentReminder(recordId: RecordId): Promise<ReminderRevision | null> {
    const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
    return head?.state === "ACTIVE" ? carePlanRevision<ReminderRevision>(head.headRevisionId) : null;
  }

  return Object.freeze({
    load,

    async recordOccasion(input: RecordOccasionInput): Promise<SaveRecordResult> {
      const payload = eventPayload(input);
      if (!payload) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      const result = await dependencies.journal.recordMedicationEvent({
        payload,
        temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
        recordedAt: dependencies.now(),
        commandId: input.commandId,
      });
      if (result.kind !== "COMMITTED") return failure(result.code);
      return afterSave(result.recordId, input.state, input.locale);
    },

    async correctOccasion(input) {
      const payload = eventPayload(input);
      if (!payload) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      const previous = await eventRevision(input.expectedRevisionId);
      if (!previous) return { kind: "FAILED", code: "HEAD_CONFLICT" };
      const result = await dependencies.journal.correctMedicationEvent({
        recordId: input.recordId,
        expectedRevisionId: input.expectedRevisionId,
        expectedRevisionNumber: input.expectedRevisionNumber,
        payload,
        temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
        recordedAt: previous.recordedAt,
        commandId: input.commandId,
      });
      if (result.kind !== "COMMITTED") return failure(result.code);
      return afterSave(result.recordId, input.state, input.locale);
    },

    async openBarrierQuestion(medicationEventRecordId, locale) {
      const offer = await dependencies.inquiry.offerForMedicationEvent(medicationEventRecordId, locale);
      return offer.kind === "PRESENTED" ? offer.question : null;
    },

    async answerBarrier(input) {
      return actionResult(
        await dependencies.inquiry.answer({
          inquiryRecordId: input.question.inquiryRecordId,
          presentationKey: input.question.presentationKey,
          rawAnswer: rawAnswerOf(input.answer),
          commandId: input.commandId,
        }),
      );
    },

    async snoozeBarrier(question, choice) {
      return actionResult(await dependencies.inquiry.snooze({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, choice }));
    },

    async dismissBarrier(question) {
      return actionResult(await dependencies.inquiry.dismiss({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey }));
    },

    async correctBarrier(input) {
      return actionResult(await dependencies.inquiry.correctResponse({ responseRecordId: input.responseRecordId, rawAnswer: rawAnswerOf(input.answer), commandId: input.commandId }));
    },

    async removeBarrier(responseRecordId) {
      return actionResult(await dependencies.inquiry.removeResponse({ responseRecordId }));
    },

    async saveReminder(input) {
      const current = await currentReminder(input.reminder.recordId);
      if (!current || current.revisionId !== input.reminder.revisionId || current.payload.schedule.kind !== "WEEKLY_LOCAL") {
        return { kind: "FAILED", code: "HEAD_CONFLICT" };
      }
      const schedule = current.payload.schedule;
      let payload: ReminderPayload;
      let reason: "PAUSED" | "RESUMED" | "ENDED" | "REVIEW_CONFIRMED" | "SCHEDULE_CHANGED";
      switch (input.change.kind) {
        case "PAUSE":
          payload = { ...current.payload, state: "PAUSED" };
          reason = "PAUSED";
          break;
        case "RESUME":
          payload = { ...current.payload, state: "ACTIVE" };
          reason = "RESUMED";
          break;
        case "END":
          payload = { ...current.payload, state: "ENDED" };
          reason = "ENDED";
          break;
        case "CHANGE_TIME":
          payload = { ...current.payload, schedule: { ...schedule, times: [input.change.time as never] } };
          reason = "SCHEDULE_CHANGED";
          break;
        case "CONFIRM_REVIEW": {
          const prescription = input.reminder.currentPrescription;
          if (current.payload.subject.kind !== "MEDICATION" || !prescription) return { kind: "FAILED", code: "VALIDATION_FAILED" };
          payload = {
            ...current.payload,
            state: "ACTIVE",
            subject: { kind: "MEDICATION", target: { recordType: "PRESCRIPTION_VERSION", recordId: prescription.recordId, revisionId: prescription.revisionId } },
            // The reminder relays the recorded time; it never invents one.
            schedule: prescription.times.length > 0 ? { ...schedule, times: [...prescription.times] as never } : schedule,
          };
          reason = "REVIEW_CONFIRMED";
          break;
        }
      }
      const result = await dependencies.carePlan.reviseReminder({
        recordId: current.recordId,
        expectedRevisionId: current.revisionId,
        expectedRevisionNumber: current.revisionNumber,
        payload,
        intent: "SUPERSEDE",
        reason,
        patientConfirmed: true,
        commandId: input.commandId,
      });
      return actionResult(result);
    },

    async saveCareQuestion(input) {
      return actionResult(await dependencies.carePlan.createCareQuestion({ questionText: { text: input.text, language: input.language }, commandId: input.commandId }));
    },

    async editCareQuestion(input) {
      return actionResult(
        await dependencies.carePlan.reviseCareQuestion({
          recordId: input.question.recordId,
          expectedRevisionId: input.question.revisionId,
          expectedRevisionNumber: input.question.revisionNumber,
          questionText: { text: input.text, language: input.language },
          state: "READY_TO_ASK",
          commandId: input.commandId,
        }),
      );
    },

    async dismissCareQuestion(input) {
      return actionResult(
        await dependencies.carePlan.reviseCareQuestion({
          recordId: input.question.recordId,
          expectedRevisionId: input.question.revisionId,
          expectedRevisionNumber: input.question.revisionNumber,
          questionText: { text: input.question.text, language: input.question.language },
          state: "DISMISSED",
          commandId: input.commandId,
        }),
      );
    },
  });
}

export { ALL_DAYS as REMINDER_EVERY_DAY };
export type { RevisionId };
