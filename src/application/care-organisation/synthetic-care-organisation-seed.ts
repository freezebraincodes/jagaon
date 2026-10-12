import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { WorkItemId } from "@/application/contracts/event-work";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { JagaOnDatabase } from "@/storage/database";
import type { PreventiveCareItemPayload } from "@/domain/care-plan/preventive-care";
import { localDateSchema } from "@/domain/shared/time";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createCareOrganisationService } from "./care-organisation-service";

/**
 * Deterministic synthetic Packet 9B fixture (mockup frames 09 and 10). Every
 * value is invented. It is written only through the authoritative commands
 * and only when no preventive-care item or appointment head exists, so a
 * patient's own entries are never overwritten or duplicated.
 */

const SINGAPORE = "Asia/Singapore";
const day = (localDate: string) => ({ kind: "DATE_ONLY" as const, localDate: localDateSchema.parse(localDate), timeZoneId: SINGAPORE });
const catalogue = (catalogueEntryKey: string, label: string): PreventiveCareItemPayload["identity"] => ({
  kind: "REVIEWED_CATALOGUE_MATCH",
  catalogueEntryKey,
  catalogueVersion: "preventive-care-catalogue.1",
  label,
});

export const SYNTHETIC_CARE_ORGANISATION_DATES = Object.freeze({
  eyeScreening: "2026-11-03",
  bloodTest: "2026-10-14",
  footCheckRecorded: "2026-09-14",
  appointmentInstant: "2026-10-14T01:40:00.000Z",
});

export const SYNTHETIC_CARE_QUESTION_TEXT = "Should I change anything before my next appointment?";

function committed<T extends { kind: string }>(result: T): Extract<T, { kind: "COMMITTED" }> {
  if (result.kind !== "COMMITTED") throw new Error("SYNTHETIC_CARE_ORGANISATION_SEED_FAILED");
  return result as Extract<T, { kind: "COMMITTED" }>;
}

type SeedIds = {
  commandId(): CommandId;
  correlationId(): CorrelationId;
  recordId(): RecordId;
  revisionId(): RevisionId;
  auditEventId(): AuditEventId;
  transactionId(): TransactionId;
  domainEventId(): DomainEventId;
  workItemId(): WorkItemId;
};

export async function seedSyntheticCareOrganisation(input: {
  database: JagaOnDatabase;
  seedAt: Instant;
  ids: SeedIds;
  /** The demo question (default on). Tests that exercise question handling from an empty list turn it off. */
  demoQuestion?: boolean;
}): Promise<"SEEDED" | "SKIPPED"> {
  const existing = (await input.database.table("recordHeads").where("recordType").anyOf(["PREVENTIVE_CARE_ITEM", "APPOINTMENT"]).toArray()) as RecordHead[];
  if (existing.length > 0) return "SKIPPED";
  // A stepping clock keeps the fixture's entry order deterministic.
  let step = 0;
  const now = () => new Date(Date.parse(input.seedAt) - 3_600_000 + (step += 1) * 1000).toISOString() as Instant;
  const carePlan = createCarePlanCommandService(input.database, { now, ids: input.ids });
  const co = createCareOrganisationService(input.database, { now, ids: input.ids, carePlan });

  committed(
    await co.createPreventiveItem({
      payload: {
        identity: catalogue("EYE_SCREENING", "Eye screening"),
        trackingState: "ACTIVE",
        schedule: { kind: "TARGET_DATE", targetDate: localDateSchema.parse(SYNTHETIC_CARE_ORGANISATION_DATES.eyeScreening) },
        patientReportedPlanText: { text: "Appointment letter, 2 Sep 2026", language: "en-SG" },
        patientNote: { text: "Afternoon slot", language: "en-SG" },
      },
    }),
  );
  const bloodTest = committed(
    await co.createPreventiveItem({
      payload: {
        identity: catalogue("BLOOD_TEST", "Blood test"),
        trackingState: "ACTIVE",
        schedule: { kind: "TARGET_DATE", targetDate: localDateSchema.parse(SYNTHETIC_CARE_ORGANISATION_DATES.bloodTest) },
        patientNote: { text: "Same day as visit", language: "en-SG" },
      },
    }),
  );
  const footCheck = committed(
    await co.createPreventiveItem({
      payload: {
        identity: catalogue("FOOT_CHECK", "Foot check"),
        trackingState: "ACTIVE",
        schedule: { kind: "TARGET_DATE", targetDate: localDateSchema.parse(SYNTHETIC_CARE_ORGANISATION_DATES.footCheckRecorded) },
      },
    }),
  );
  committed(
    await co.createPreventiveItem({
      payload: {
        identity: catalogue("FLU_VACCINE", "Flu vaccine"),
        trackingState: "ACTIVE",
        schedule: { kind: "UNSCHEDULED" },
        patientNote: { text: "Want to ask the clinic", language: "en-SG" },
      },
    }),
  );
  // The patient's own report that the foot check happened; nothing infers it.
  committed(
    await co.recordPreventiveOutcome({
      payload: {
        careReference: { kind: "PLANNED_ITEM", item: { recordType: "PREVENTIVE_CARE_ITEM", recordId: footCheck.recordId, revisionId: footCheck.revisionId } },
        completionReport: { kind: "PATIENT_REPORTED_COMPLETED" },
      },
      occurrence: day(SYNTHETIC_CARE_ORGANISATION_DATES.footCheckRecorded),
    }),
  );
  const appointment = committed(
    await co.scheduleAppointment({
      payload: {
        appointmentLabel: "Dr Lim, Bukit Merah Polyclinic",
        service: { kind: "UNKNOWN" },
        mode: "IN_PERSON",
        status: "SCHEDULED",
        relatedPreventiveCareItems: [{ recordType: "PREVENTIVE_CARE_ITEM", recordId: bloodTest.recordId, revisionId: bloodTest.revisionId }],
        careContactLabel: "Dr Lim",
        locationLabel: "Bukit Merah Polyclinic",
      },
      scheduledAt: { kind: "EXACT", instantUtc: SYNTHETIC_CARE_ORGANISATION_DATES.appointmentInstant as Instant, timeZoneId: SINGAPORE, utcOffsetMinutes: 480 },
    }),
  );
  // Owner decision 2026-10-12: one short question for the appointment, saved as the add-question screen saves one, so the visit
  // summary can be prepared in the demo without typing. It is the patient's own wording; JagaOn never answers it.
  if (input.demoQuestion === false) return "SEEDED";
  committed(
    await co.createCareQuestion({
      questionText: { text: SYNTHETIC_CARE_QUESTION_TEXT, language: "und" },
      relatedAppointment: { recordType: "APPOINTMENT", recordId: appointment.recordId, revisionId: appointment.revisionId },
    }),
  );
  return "SEEDED";
}
