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
import type {
  JournalCommandService,
  JournalQueryPort,
} from "./journal-contracts";
import { createJournalCommandService } from "./journal-command-service";
import { createJournalQueryService } from "./journal-query-service";

export type JagaOnRuntime = {
  databaseName: string;
  commands: JournalCommandService;
  query: JournalQueryPort;
  resolveLocale(): Promise<SupportedLocale>;
  persistLocale(locale: SupportedLocale): Promise<void>;
  resetDemo(): Promise<void>;
  close(): void;
};

export async function createBrowserJournalRuntime(
  databaseName?: string,
): Promise<JagaOnRuntime> {
  const database = createJagaOnDatabase(databaseName);
  await database.open();

  const now = () => new Date().toISOString() as Instant;
  const commands = createJournalCommandService(database, {
    now,
    ids: {
      commandId: createCommandId,
      correlationId: createCorrelationId,
      recordId: createRecordId,
      revisionId: createRevisionId,
      auditEventId: createAuditEventId,
      transactionId: createTransactionId,
      domainEventId: createDomainEventId,
    },
  });
  const query = createJournalQueryService(database);
  const localeRepository = createBootstrapLocaleRepository(database);

  async function seedSyntheticScenarioWhenEmpty(): Promise<void> {
    const current = await query.loadToday();
    if (current.unavailable || current.entries.length > 0) return;

    const result = await commands.recordGlucose({
      payload: {
        measurement: {
          enteredValue: "6.2" as never,
          enteredUnit: "MMOL_L",
          normalization: null,
        },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: {
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-10-01T23:48:00Z" as Instant,
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
      },
      recordedAt: "2026-10-02T00:00:00Z" as Instant,
    });
    if (result.kind !== "COMMITTED") {
      throw new Error("SYNTHETIC_SCENARIO_BOOTSTRAP_FAILED");
    }
  }

  await seedSyntheticScenarioWhenEmpty();

  return Object.freeze({
    databaseName: database.name,
    commands,
    query,
    resolveLocale: () => localeRepository.resolve(null, now()),
    async persistLocale(locale: SupportedLocale) {
      await localeRepository.resolve(locale, now());
    },
    async resetDemo() {
      await resetSyntheticDemoStorage(database, {
        releaseProfile: CURRENT_RELEASE_PROFILE,
        confirmation: DEMO_STORAGE_RESET_CONFIRMATION,
        resetAt: now(),
      });
      await seedSyntheticScenarioWhenEmpty();
    },
    close() {
      database.close();
    },
  });
}
