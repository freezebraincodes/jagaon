import {
  createCommandId,
  createCorrelationId,
  createDomainEventId,
} from "@/application/contracts/command-event-identifiers";
import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import {
  createAuditEventId,
  createRecordId,
  createRevisionId,
  createTransactionId,
} from "@/domain/shared/identifiers";
import type { Instant } from "@/domain/shared/time";
import { createBootstrapLocaleRepository } from "@/storage/bootstrap-locale-repository";
import { createJagaOnDatabase } from "@/storage/database";
import {
  DEMO_STORAGE_RESET_CONFIRMATION,
  resetSyntheticDemoStorage,
} from "@/storage/demo-storage-reset";
import { createWorkItemId } from "@/application/contracts/event-work";
import { createIntelligenceCoordinator } from "@/application/intelligence/intelligence-coordinator";
import { createRecordedHistoryQuery } from "@/application/history/recorded-history-query";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import { seedSyntheticHistory } from "@/application/history/synthetic-history-seed";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createReminderReconciliation } from "@/application/care-plan/reminder-reconciliation";
import { createInquiryService } from "@/application/inquiry/inquiry-service";
import { barrierPresentationCopyFor } from "@/application/medication-schedule/barrier-presentation-copy";
import type { MedicationSchedulePort } from "@/application/medication-schedule/medication-schedule-contracts";
import { createMedicationScheduleService } from "@/application/medication-schedule/medication-schedule-service";
import { seedSyntheticCarePlan } from "@/application/medication-schedule/synthetic-care-plan-seed";
import type { CareOrganisationCommandPort, CareOrganisationCommitResult } from "@/application/care-organisation/care-organisation-contracts";
import type { CareOrganisationQueryPort } from "@/application/care-organisation/care-organisation-query";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import type { CarePreparationCommandPort, CarePreparationQueryPort } from "@/application/care-preparation/care-preparation-contracts";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { createCarePreparationQuery } from "@/application/care-preparation/care-preparation-query";
import { createCareSummaryInvalidation } from "@/application/care-preparation/care-summary-invalidation";
import type {
  JournalCommandService,
  JournalCommitResult,
  JournalQueryPort,
} from "./journal-contracts";
import { createJournalCommandService } from "./journal-command-service";
import { createJournalQueryService } from "./journal-query-service";

export type JagaOnRuntime = {
  databaseName: string;
  commands: JournalCommandService;
  query: JournalQueryPort;
  /** Packet 7A: validated descriptive Recorded-history view models. */
  history: RecordedHistoryQueryPort;
  /** Packet 8: Medication schedule view models and patient-confirmed commands. */
  medicationSchedule: MedicationSchedulePort;
  /** Packet 9B: patient-maintained health checks, appointments and questions (Screens 09–10). */
  careOrganisation: { commands: CareOrganisationCommandPort; query: CareOrganisationQueryPort };
  /** Packet 9C: patient-controlled care-summary snapshots and one-attempt local printing. */
  carePreparation: { commands: CarePreparationCommandPort; query: CarePreparationQueryPort };
  resolveLocale(): Promise<SupportedLocale>;
  persistLocale(locale: SupportedLocale): Promise<void>;
  resetDemo(): Promise<void>;
  close(): void;
};

export type BrowserJournalRuntimeOptions = {
  /** Injectable clock for deterministic tests; defaults to the device clock. */
  now?: () => Instant;
};

export async function createBrowserJournalRuntime(
  databaseName?: string,
  options: BrowserJournalRuntimeOptions = {},
): Promise<JagaOnRuntime> {
  const database = createJagaOnDatabase(databaseName);
  await database.open();

  const now = options.now ?? (() => new Date().toISOString() as Instant);
  const ids = {
    commandId: createCommandId,
    correlationId: createCorrelationId,
    recordId: createRecordId,
    revisionId: createRevisionId,
    auditEventId: createAuditEventId,
    transactionId: createTransactionId,
    domainEventId: createDomainEventId,
    workItemId: createWorkItemId,
  };
  const journalCommands = createJournalCommandService(database, { now, ids });
  const query = createJournalQueryService(database);
  const localeRepository = createBootstrapLocaleRepository(database);
  const coordinator = createIntelligenceCoordinator(database, {
    now,
    ids: { ...ids, evaluationId: () => crypto.randomUUID(), leaseToken: () => crypto.randomUUID() },
    instanceId: "browser",
  });
  const historyQuery = createRecordedHistoryQuery(database, { now });
  const leaseToken = () => crypto.randomUUID();
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const reminders = createReminderReconciliation(database, { now, newCommandId: createCommandId, leaseToken, instanceId: "browser", carePlan });
  const inquiry = createInquiryService(database, {
    now,
    ids: { ...ids, presentationKey: () => crypto.randomUUID(), leaseToken },
    instanceId: "browser",
    copy: barrierPresentationCopyFor,
  });

  // Ordinary intelligence runs after the journal transaction commits and is
  // serialised; history reads wait for it so they reflect committed records.
  let intelligence: Promise<unknown> = Promise.resolve();
  function scheduleIntelligence(refresh = false): Promise<unknown> {
    intelligence = intelligence
      .then(() => coordinator.processPending())
      .then(() => (refresh ? coordinator.refreshAll() : undefined))
      .catch(() => undefined);
    return intelligence;
  }

  function afterCommit<TInput>(
    command: (input: TInput) => Promise<JournalCommitResult>,
  ): (input: TInput) => Promise<JournalCommitResult> {
    return async (input) => {
      const result = await command(input);
      if (result.kind === "COMMITTED") void scheduleIntelligence();
      return result;
    };
  }

  const commands: JournalCommandService = Object.freeze({
    recordGlucose: afterCommit(journalCommands.recordGlucose),
    correctGlucoseTime: afterCommit(journalCommands.correctGlucoseTime),
    recordInsulin: afterCommit(journalCommands.recordInsulin),
    recordMeal: afterCommit(journalCommands.recordMeal),
    recordActivity: afterCommit(journalCommands.recordActivity),
  });

  const carePreparationService = createCarePreparationService(database, { now, ids });
  const carePreparationQuery = createCarePreparationQuery(database);
  const careSummaryInvalidation = createCareSummaryInvalidation(database, { now, newCommandId: createCommandId, leaseToken, instanceId: "browser", service: carePreparationService });

  // Packet 8 owned work (Inquiry eligibility, reminder review) and Packet 9C
  // summary invalidation are serialised the same way and settle before a
  // schedule read, a barrier offer or a summary read.
  let packet8: Promise<unknown> = Promise.resolve();
  function settlePacket8(): Promise<void> {
    packet8 = packet8
      .then(() => inquiry.processPending())
      .then(() => reminders.processPending())
      .then(() => inquiry.maintain())
      .then(() => careSummaryInvalidation.processPending())
      .catch(() => undefined);
    return packet8.then(() => undefined);
  }

  const schedule = createMedicationScheduleService(database, {
    now,
    journal: journalCommands,
    carePlan,
    inquiry,
    settle: async () => {
      void scheduleIntelligence();
      await settlePacket8();
    },
  });

  const careOrganisationService = createCareOrganisationService(database, { now, ids, carePlan });
  const careOrganisationQuery = createCareOrganisationQuery(database, { now });

  /** Reminder review work from a care-organisation commit settles like Packet 8 work. */
  function settlingAfterCommit<TInput>(command: (input: TInput) => Promise<CareOrganisationCommitResult>): (input: TInput) => Promise<CareOrganisationCommitResult> {
    return async (input) => {
      const result = await command(input);
      if (result.kind === "COMMITTED") void settlePacket8();
      return result;
    };
  }

  const careOrganisationCommands: CareOrganisationCommandPort = Object.freeze({
    createPreventiveItem: settlingAfterCommit(careOrganisationService.createPreventiveItem),
    revisePreventiveItem: settlingAfterCommit(careOrganisationService.revisePreventiveItem),
    recordPreventiveOutcome: settlingAfterCommit(careOrganisationService.recordPreventiveOutcome),
    correctPreventiveOutcome: settlingAfterCommit(careOrganisationService.correctPreventiveOutcome),
    undoPreventiveOutcome: settlingAfterCommit(careOrganisationService.undoPreventiveOutcome),
    scheduleAppointment: settlingAfterCommit(careOrganisationService.scheduleAppointment),
    reviseAppointment: settlingAfterCommit(careOrganisationService.reviseAppointment),
    recordContextWindow: settlingAfterCommit(careOrganisationService.recordContextWindow),
    reviseContextWindow: settlingAfterCommit(careOrganisationService.reviseContextWindow),
    createCareQuestion: settlingAfterCommit(careOrganisationService.createCareQuestion),
    reviseCareQuestion: settlingAfterCommit(careOrganisationService.reviseCareQuestion),
  });

  /** Seed only an empty demo database, never over user-created records. */
  async function seedSyntheticScenarioWhenEmpty(): Promise<void> {
    if ((await database.table("recordHeads").count()) > 0) return;
    const seedAt = now();
    await seedSyntheticHistory(journalCommands, seedAt);
    await seedSyntheticCarePlan({ database, seedAt, ids, copy: barrierPresentationCopyFor("en-SG") });
  }

  /**
   * Packet 9B fixture heads are added once, including to an existing Packet 8
   * demo database; any existing health-check item or appointment skips it.
   */
  async function seedCareOrganisationWhenMissing(): Promise<void> {
    await seedSyntheticCareOrganisation({ database, seedAt: now(), ids });
  }

  await seedSyntheticScenarioWhenEmpty();
  await seedCareOrganisationWhenMissing();
  // A print attempt interrupted by a closed tab becomes OUTCOME_UNKNOWN; it is never replayed.
  await carePreparationService.recoverInterruptedExports().catch(() => 0);
  void scheduleIntelligence(true);

  return Object.freeze({
    databaseName: database.name,
    commands,
    query,
    history: Object.freeze({
      async load(request: Parameters<RecordedHistoryQueryPort["load"]>[0]) {
        await intelligence;
        return historyQuery.load(request);
      },
    }),
    medicationSchedule: Object.freeze({
      ...schedule,
      async load(request: Parameters<MedicationSchedulePort["load"]>[0]) {
        await settlePacket8();
        return schedule.load(request);
      },
    }),
    carePreparation: Object.freeze({
      // Only the patient-facing port; the worker's system effects stay internal.
      commands: Object.freeze({
        async prepare(input: Parameters<CarePreparationCommandPort["prepare"]>[0]) {
          await settlePacket8();
          return carePreparationService.prepare(input);
        },
        markPreviewed: carePreparationService.markPreviewed,
        approve: carePreparationService.approve,
        invalidate: carePreparationService.invalidate,
        supersede: carePreparationService.supersede,
        requestPrintExport: carePreparationService.requestPrintExport,
        completePrintExport: carePreparationService.completePrintExport,
        recoverInterruptedExports: carePreparationService.recoverInterruptedExports,
      } satisfies CarePreparationCommandPort),
      query: Object.freeze({
        async loadSummary(recordId: Parameters<CarePreparationQueryPort["loadSummary"]>[0]) {
          await settlePacket8();
          return carePreparationQuery.loadSummary(recordId);
        },
      }),
    }),
    careOrganisation: Object.freeze({
      commands: careOrganisationCommands,
      query: Object.freeze({
        async loadPreventiveCare() {
          await packet8;
          return careOrganisationQuery.loadPreventiveCare();
        },
        async loadVisitPreparation() {
          await packet8;
          return careOrganisationQuery.loadVisitPreparation();
        },
      }),
    }),
    resolveLocale: () => localeRepository.resolve(null, now()),
    async persistLocale(locale: SupportedLocale) {
      await localeRepository.resolve(locale, now());
    },
    async resetDemo() {
      await intelligence;
      await packet8;
      await resetSyntheticDemoStorage(database, {
        releaseProfile: CURRENT_RELEASE_PROFILE,
        confirmation: DEMO_STORAGE_RESET_CONFIRMATION,
        resetAt: now(),
      });
      await seedSyntheticScenarioWhenEmpty();
      await seedCareOrganisationWhenMissing();
      await scheduleIntelligence(true);
    },
    close() {
      database.close();
    },
  });
}
