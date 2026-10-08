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
import { storageFailure } from "@/storage/storage-failure";
import { createStorageMetadataRepository, localStateCleanupPendingRow } from "@/storage/storage-metadata";
import { acquireDatasetPresence } from "@/application/storage/browser-dataset-lifecycle";
import type { ConfirmDeletionResult, DeletionConfirmation, DeletionPlan, DeletionTarget, PrepareDeletionResult } from "@/application/deletion/deletion-contracts";
import { createPermanentDeletionService } from "@/application/deletion/permanent-deletion-service";
import { createRestoreReconciler } from "@/application/restore/restore-reconciler";
import { createBackupExportService, type BackupExportResult, type BackupExportStep } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { createBrowserBackupFilePort } from "@/backup/browser-backup-file-port";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import {
  createIntegrityGate,
  IntegrityLockedError,
  lockStateFor,
  openVerifiedDataset,
  type StorageLockState,
} from "@/application/storage/integrity-gate";
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
  /** Packet 10A: exact, confirmed permanent deletion of one patient record. */
  recordDeletion: {
    prepare(target: DeletionTarget): Promise<PrepareDeletionResult>;
    confirm(plan: DeletionPlan, confirmation: DeletionConfirmation): Promise<ConfirmDeletionResult>;
  };
  /** Packet 10B: local encrypted backup export (no network, no write). */
  backup: {
    export(request: { passphrase: string; confirmation: string }, events?: { onStepCompleted?(step: BackupExportStep): void }): Promise<BackupExportResult>;
  };
  /** Packet 10: whether this open created, migrated or reopened the dataset. */
  datasetLifecycle: "CREATED" | "MIGRATED" | "EXISTING";
  /**
   * Corrective Pass C: the durable LOCAL_STATE_CLEANUP_PENDING marker. The
   * shell reads it before trusting persisted setup and calls `complete` only
   * after every local-state owner confirmed its keys are gone.
   */
  localStateCleanup: {
    isPending(): Promise<boolean>;
    complete(): Promise<void>;
  };
  /** Packet 10A: the in-memory integrity lock, if any operation hit one. */
  integrityLock(): StorageLockState | null;
  onIntegrityLock(listener: (lock: StorageLockState) => void): () => void;
  close(): void;
};

export type BrowserJournalRuntimeOptions = {
  /** Injectable clock for deterministic tests; defaults to the device clock. */
  now?: () => Instant;
  /**
   * Packet 10 freeze Section 6: the synthetic scenario is seeded only when this
   * open creates a new dataset. Delete-all restarts pass `false` so the new
   * dataset stays empty and restorable.
   */
  seedSyntheticScenarioOnCreate?: boolean;
  /** Injectable dataset identity for deterministic tests. */
  newDatasetIdentity?: () => string;
  /** Packet 10C: the shell locale to rebuild as the bootstrap projection after a restore. */
  bootstrapLocaleAfterRestore?: SupportedLocale;
  /** Set only by an explicit patient recovery action: resume a `FAILED_BLOCKING` restore. */
  resumeFailedRestore?: boolean;
  /**
   * Corrective Pass C: persist LOCAL_STATE_CLEANUP_PENDING. `IF_CREATED` writes
   * it only when this open creates the dataset (atomically with the identity);
   * `ALWAYS` also writes it into an existing dataset. If it cannot be
   * persisted, the open fails with `LocalStateCleanupUnconfirmedError`.
   */
  localStateCleanup?: { requestedAt: Instant; when: "IF_CREATED" | "ALWAYS" };
};

/** The cleanup marker could not be persisted; carries no data. Callers must fail closed. */
export class LocalStateCleanupUnconfirmedError extends Error {
  readonly name = "LocalStateCleanupUnconfirmedError";
  constructor() {
    super("LOCAL_STATE_CLEANUP_UNCONFIRMED");
  }
}

/** Thrown when the dataset cannot be opened safely; carries only the closed lock. */
export { IntegrityLockedError as JagaOnStorageLockedError };

export async function createBrowserJournalRuntime(
  databaseName?: string,
  options: BrowserJournalRuntimeOptions = {},
): Promise<JagaOnRuntime> {
  const now = options.now ?? (() => new Date().toISOString() as Instant);
  const name = databaseName ?? "jagaon";
  const gate = createIntegrityGate(now);
  let closeDatabase: () => void = () => undefined;
  // Another tab's delete-all holds the dataset exclusively; wait rather than recreate it.
  const releasePresence = await acquireDatasetPresence(name, () => {
    gate.lock(lockStateFor(storageFailure("OPEN", "DATABASE_OPEN_FAILED", now())));
    closeDatabase();
  });
  const cleanupRequest = options.localStateCleanup;
  const opened = await openVerifiedDataset(name, {
    now,
    newDatasetIdentity: options.newDatasetIdentity ?? (() => crypto.randomUUID()),
    ...(cleanupRequest ? { localStateCleanupPendingOnCreate: cleanupRequest.requestedAt } : {}),
  });
  if (opened.kind === "LOCKED") {
    releasePresence();
    // A creation that could not also persist the requested marker created nothing.
    if (cleanupRequest && opened.attemptedCreate) throw new LocalStateCleanupUnconfirmedError();
    throw new IntegrityLockedError(opened.lock);
  }
  const database = opened.database;
  closeDatabase = () => database.close();
  const metadata = createStorageMetadataRepository(database);
  if (cleanupRequest?.when === "ALWAYS" && opened.lifecycle !== "CREATED") {
    try {
      await metadata.writeLocalStateCleanupPending(localStateCleanupPendingRow(cleanupRequest.requestedAt));
    } catch {
      database.close();
      releasePresence();
      throw new LocalStateCleanupUnconfirmedError();
    }
  }
  // Only RECONCILING resumes automatically; FAILED_BLOCKING stays locked until the
  // patient explicitly chooses recovery (spec 8.8, 9.4).
  if (opened.restoreState?.phase === "FAILED_BLOCKING" && !options.resumeFailedRestore) {
    database.close();
    releasePresence();
    throw new IntegrityLockedError(lockStateFor(storageFailure("RESTORE_RECONCILE", "RESTORE_RECONCILIATION_FAILED", now())));
  }
  const restoreInProgress = opened.restoreState !== null && (opened.restoreState.phase === "RECONCILING" || opened.restoreState.phase === "FAILED_BLOCKING");
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
    // Background engines stop while integrity-locked (spec 9.4).
    intelligence = intelligence
      .then(() => gate.run(() => coordinator.processPending()))
      .then(() => (refresh ? gate.run(() => coordinator.refreshAll()) : undefined))
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
      .then(() => gate.run(() => inquiry.processPending()))
      .then(() => gate.run(() => reminders.processPending()))
      .then(() => gate.run(() => inquiry.maintain()))
      .then(() => gate.run(() => careSummaryInvalidation.processPending()))
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

  // A committed restore finishes durable reconciliation before any port, seed
  // or background work is available (spec 8.7–8.8); failure keeps it locked.
  if (restoreInProgress) {
    const reconciled = await createRestoreReconciler(database, {
      now,
      resumeFailedBlocking: options.resumeFailedRestore === true,
      owners: {
        async rebuildBootstrapLocale() {
          await localeRepository.resolve(options.bootstrapLocaleAfterRestore ?? null, now());
        },
        async inquiryMaintenance() {
          await inquiry.processPending();
          await inquiry.maintain();
        },
        async patternLearningRefresh() {
          await coordinator.processPending();
          await coordinator.refreshAll();
        },
        async reminderReconciliation() {
          await reminders.processPending();
        },
        async careSummaryInvalidation() {
          await careSummaryInvalidation.processPending();
        },
      },
    }).resume();
    if (reconciled.kind === "FAILED") {
      database.close();
      releasePresence();
      throw new IntegrityLockedError(lockStateFor(reconciled.failure));
    }
  }

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

  if (opened.lifecycle === "CREATED" && options.seedSyntheticScenarioOnCreate !== false) {
    await seedSyntheticScenarioWhenEmpty();
    await seedCareOrganisationWhenMissing();
  } else if (opened.lifecycle === "MIGRATED") {
    // A Packet 8/9 database keeps its once-only Packet 9B fixture top-up.
    await seedCareOrganisationWhenMissing();
  }
  // A print attempt interrupted by a closed tab becomes OUTCOME_UNKNOWN; it is never replayed.
  await carePreparationService.recoverInterruptedExports().catch(() => 0);
  void scheduleIntelligence(true);

  // Every port runs through the integrity gate: once locked, no authoritative
  // write, read-as-truth or engine work proceeds (spec 9.4).
  const deletion = createPermanentDeletionService(database, { now, ids });
  const backupExport = createBackupExportService({
    snapshot: createBackupSnapshotRepository(database),
    crypto: () => createWebCryptoPort(),
    file: createBrowserBackupFilePort(),
    now,
  });
  const ports = gate.guard({
    backup: Object.freeze({ export: backupExport.export }),
    recordDeletion: Object.freeze({
      async prepare(target: DeletionTarget) {
        await intelligence;
        await packet8;
        return deletion.prepare(target);
      },
      async confirm(plan: DeletionPlan, confirmation: DeletionConfirmation) {
        const result = await deletion.confirm(plan, confirmation);
        if (result.kind === "DELETED") {
          // Owners reconcile the PATIENT_RECORD_DELETED work through their normal subscriptions.
          void scheduleIntelligence();
          void settlePacket8();
        }
        return result;
      },
    }),
    commands,
    query,
    history: Object.freeze({
      async load(request: Parameters<RecordedHistoryQueryPort["load"]>[0]) {
        await intelligence;
        return historyQuery.load(request);
      },
      async loadExplainablePattern(request: Parameters<RecordedHistoryQueryPort["loadExplainablePattern"]>[0]) {
        await intelligence;
        return historyQuery.loadExplainablePattern(request);
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
  });

  return Object.freeze({
    databaseName: database.name,
    datasetLifecycle: opened.lifecycle,
    localStateCleanup: Object.freeze({
      isPending: async () => (await metadata.readLocalStateCleanupPending()) !== null,
      complete: () => metadata.clearLocalStateCleanupPending(),
    }),
    ...ports,
    integrityLock: gate.current,
    onIntegrityLock: gate.subscribe,
    close() {
      database.close();
      releasePresence();
    },
  });
}
