import Dexie from "dexie";
import type { Instant } from "@/domain/shared";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { createCarePreparationService } from "./care-preparation-service";
import { createCarePreparationQuery } from "./care-preparation-query";
import { createCareSummaryInvalidation } from "./care-summary-invalidation";
import type { CareSummarySelectionInput } from "./care-preparation-contracts";

/** Shared fake-IndexedDB harness for Packet 9C application tests (test-only module). */

export const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const uuid = () => crypto.randomUUID() as never;
export const testIds = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
export const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });

const opened: JagaOnDatabase[] = [];

export async function closeCarePreparationHarnesses() {
  for (const database of opened.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
}

export async function createCarePreparationHarness() {
  const database = createJagaOnDatabase(`packet9c-${crypto.randomUUID()}`);
  opened.push(database);
  await database.open();
  const now = () => NOW;
  const carePlan = createCarePlanCommandService(database, { now, ids: testIds });
  const journal = createJournalCommandService(database, { now, ids: testIds });
  const organisation = createCareOrganisationService(database, { now, ids: testIds, carePlan });
  const visit = createCareOrganisationQuery(database, { now });
  const service = createCarePreparationService(database, { now, ids: testIds });
  const query = createCarePreparationQuery(database);
  const invalidation = createCareSummaryInvalidation(database, { now, newCommandId: uuid, leaseToken: () => crypto.randomUUID(), instanceId: "test", service });
  await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids: testIds });

  async function selection(overrides: Partial<CareSummarySelectionInput> = {}): Promise<CareSummarySelectionInput> {
    const view = await visit.loadVisitPreparation();
    if (view.status !== "READY" || !view.appointment) throw new Error("visit");
    return {
      locale: "en-SG",
      period: view.period,
      appointment: { recordType: "APPOINTMENT", recordId: view.appointment.recordId, revisionId: view.appointment.revisionId },
      groups: view.factGroups.filter((group) => group.sources.length > 0).map((group) => ({ key: group.key, sources: group.sources })),
      questions: view.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
      notSelected: [],
      ...overrides,
    };
  }

  return { database, carePlan, journal, organisation, visit, service, query, invalidation, selection };
}
