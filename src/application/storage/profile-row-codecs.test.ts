import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { validateClosedStoredRow } from "@/storage/closed-row-codecs";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "@/storage/table-catalogue";
import { HACKATHON_CLOSED_ROW_CODECS } from "./profile-row-codecs";
import { createPopulatedDataset, openRaw, readAllTables, installFakeIndexedDb } from "./packet10-test-support";

installFakeIndexedDb();
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const INTEGRATION_TIMEOUT_MS = 60_000;

async function populated() {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  const tables = await readAllTables(database);
  database.close();
  return tables;
}

function rejected(table: JagaOnTableName, value: unknown): boolean {
  try {
    validateClosedStoredRow(HACKATHON_CLOSED_ROW_CODECS, table, value);
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageRowValidationError);
    expect((error as StorageRowValidationError).code).toBe("STORAGE_INTEGRITY_FAILED");
    return true;
  }
}

describe("HACKATHON_DEMO closed row codecs over a real populated dataset", () => {
  it(
    "validates every stored row of every owner and table",
    async () => {
      const tables = await populated();
      const types = new Set((tables.recordHeads as Array<{ recordType: string }>).map((head) => head.recordType));
      // Every enabled owner wrote rows through its real command path.
      for (const type of ["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT", "MEDICATION", "PRESCRIPTION_VERSION", "REMINDER", "APPOINTMENT", "PREVENTIVE_CARE_ITEM", "CARE_QUESTION", "PATTERN_OBSERVATION", "CARE_SUMMARY_SNAPSHOT"]) {
        expect(types.has(type), type).toBe(true);
      }
      for (const table of JAGAON_TABLE_NAMES) {
        for (const row of tables[table]) validateClosedStoredRow(HACKATHON_CLOSED_ROW_CODECS, table, row);
      }
      expect(tables.aiInvocationAudits).toEqual([]);
      expect(tables.governedAssets).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects unknown fields, discriminator mismatch and unsupported schema versions in every populated table",
    async () => {
      const tables = await populated();
      for (const table of JAGAON_TABLE_NAMES) {
        const sample = tables[table][0] as Record<string, unknown> | undefined;
        if (!sample) {
          expect(rejected(table, { anything: 1 }), table).toBe(true);
          continue;
        }
        expect(rejected(table, { ...sample, unexpectedField: "x" }), `${table} unknown field`).toBe(true);
      }
      const revision = tables.recordRevisions[0] as Record<string, unknown>;
      expect(rejected("recordRevisions", { ...revision, schemaVersion: 99 })).toBe(true);
      expect(rejected("recordRevisions", { ...revision, recordType: "SAFETY_EVENT" })).toBe(true);
      const audit = tables.auditEvents[0] as Record<string, unknown>;
      expect(rejected("auditEvents", { ...audit, recordType: "SAFETY_EVENT" })).toBe(true);
      const event = tables.domainEvents[0] as Record<string, unknown>;
      expect(rejected("domainEvents", { ...event, eventName: "SAFETY_EVENT_OPENED" })).toBe(true);
      expect(rejected("domainEvents", { ...event, change: { ...(event.change as object), recordType: "KETONE_READING" } })).toBe(true);
      const head = tables.recordHeads[0] as Record<string, unknown>;
      expect(rejected("recordHeads", { ...head, state: "ARCHIVED" })).toBe(true);
      expect(rejected("storageMetadata", { key: "DATABASE_IDENTITY", datasetIdentity: "x" })).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
