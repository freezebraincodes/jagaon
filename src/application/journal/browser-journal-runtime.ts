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

  // Packet 8 owned work (Inquiry eligibility, reminder review) is serialised
  // the same way and settles before a schedule read or a barrier offer.
  let packet8: Promise<unknown> = Promise.resolve();
  function settlePacket8(): Promise<void> {
    packet8 = packet8
      .then(() => inquiry.processPending())
      .then(() => reminders.processPending())
      .then(() => inquiry.maintain())
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

  /** Seed only an empty demo database, never over user-created records. */
  async function seedSyntheticScenarioWhenEmpty(): Promise<void> {
    if ((await database.table("recordHeads").count()) > 0) return;
    const seedAt = now();
    await seedSyntheticHistory(journalCommands, seedAt);
    await seedSyntheticCarePlan({ database, seedAt, ids, copy: barrierPresentationCopyFor("en-SG") });
  }

  await seedSyntheticScenarioWhenEmpty();
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
      await scheduleIntelligence(true);
    },
    close() {
      database.close();
    },
  });
}
