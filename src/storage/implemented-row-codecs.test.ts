import { describe, expect, it } from "vitest";
import {
  commandReceiptSchema,
  eventConsumerReceiptSchema,
  eventSequenceSchema,
  type CommandReceipt,
  type EventConsumerReceipt,
  type EventWorkItem,
} from "@/application/contracts";
import {
  deletionTombstoneSchema,
  instantSchema,
  recordHeadSchema,
  type DeletionTombstone,
  type Instant,
  type RecordHead,
} from "@/domain/shared";
import {
  IMPLEMENTED_STORAGE_ROW_TABLES,
  implementedStorageRowCodecs,
  type ImplementedStorageRowByTable,
} from "./implemented-row-codecs";
import {
  createLanguagePreferenceRow,
  type AppPreferenceRow,
} from "./app-preference-row";
import {
  createStoredEventWorkItem,
  type StoredEventWorkItem,
} from "./stored-event-work-item";
import { StorageRowValidationError } from "./storage-row-codec";
import type { StoredReverseDependency } from "./reverse-dependency-row";
import type { StoredEngineEvaluationAudit } from "./engine-evaluation-audit-row";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

const instant = (value: string): Instant => instantSchema.parse(value);

const ID = {
  record: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  audit: "00000000-0000-4000-8000-000000000003",
  transaction: "00000000-0000-4000-8000-000000000004",
  command: "00000000-0000-4000-8000-000000000005",
  event: "00000000-0000-4000-8000-000000000006",
  work: "00000000-0000-4000-8000-000000000007",
} as const;

const appPreference: AppPreferenceRow = createLanguagePreferenceRow(
  "en-SG",
  instant("2026-09-30T10:00:00Z"),
);

const recordHead: RecordHead = recordHeadSchema.parse({
  recordId: ID.record,
  recordType: "PATIENT_PROFILE",
  headRevisionId: ID.revision,
  headRevisionNumber: 1,
  state: "ACTIVE",
  updatedAt: "2026-09-30T10:00:00Z",
});

const deletionTombstone: DeletionTombstone = deletionTombstoneSchema.parse({
  recordId: ID.record,
  recordType: "GLUCOSE_READING",
  deletedAt: "2026-09-30T10:00:00Z",
  initiator: "PATIENT",
  auditEventId: ID.audit,
  transactionId: ID.transaction,
});

const commandReceipt: CommandReceipt = commandReceiptSchema.parse({
  outcome: "NO_CHANGE",
  commandId: ID.command,
  commandHash: "a".repeat(64),
  completedAt: "2026-09-30T10:00:00Z",
  existingRevisions: [],
});

const baseWorkItem: EventWorkItem = {
  workItemId: ID.work as EventWorkItem["workItemId"],
  eventId: ID.event as EventWorkItem["eventId"],
  consumer: "MAINTENANCE",
  handlerVersion: "1",
  priority: "MAINTENANCE",
  createdAt: instant("2026-09-30T10:00:00Z"),
  attemptCount: 0,
  state: { state: "PENDING" },
  plannedCommands: [],
};

const storedWorkItem: StoredEventWorkItem = createStoredEventWorkItem(
  baseWorkItem,
  eventSequenceSchema.parse(1),
);

const consumerReceipt: EventConsumerReceipt = eventConsumerReceiptSchema.parse({
  eventId: ID.event,
  consumer: "MAINTENANCE",
  handlerVersion: "1",
  completedAt: "2026-09-30T10:00:00Z",
  outcome: { kind: "NO_ACTION_REQUIRED" },
});

const reverseDependency = {
  sourceRevisionId: ID.revision,
  dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
  dependentRecordId: "00000000-0000-4000-8000-000000000008",
  dependentRevisionId: "00000000-0000-4000-8000-000000000009",
  dependencyRole: "RECENT_EVIDENCE",
  owner: "PATTERN_ENGINE",
  evaluatorKey: "pattern.comparable-slot-trend",
  evaluatorVersion: "7a.1",
  createdAt: "2026-09-30T10:00:00Z",
} as unknown as StoredReverseDependency;

const evaluationAudit = {
  evaluationId: "00000000-0000-4000-8000-00000000000a",
  engine: "PATTERN",
  evaluatorKey: "pattern.comparable-slot-trend",
  evaluatorVersion: "7a.1",
  configurationVersion: "comparable-slot-trend-config.v1",
  runtimeManifestId: "jagaon-hackathon-intelligence",
  runtimeManifestVersion: "7a.1",
  evaluatedAt: "2026-09-30T10:00:00Z",
  inputSequenceCutoff: 4,
  candidateKey: "COMPARABLE_SLOT_TREND:PATIENT_SELECTED_SLOT:BEFORE_BREAKFAST",
  triggeringRevisions: [{ recordType: "GLUCOSE_READING", recordId: ID.record, revisionId: ID.revision }],
  consideredRevisions: [{ recordType: "GLUCOSE_READING", recordId: ID.record, revisionId: ID.revision }],
  inputFingerprint: "b".repeat(64),
  resultFingerprint: "c".repeat(64),
  dispositionKind: "RESULT",
  reasonCodes: ["PATTERN_OBSERVATION_CREATED"],
  limitationCodes: ["UNKNOWN_NEGATIVE_STATUS"],
  proposedEffectKeys: ["pattern:COMPARABLE_SLOT_TREND:PATIENT_SELECTED_SLOT:BEFORE_BREAKFAST"],
} as unknown as StoredEngineEvaluationAudit;

const validRows: ImplementedStorageRowByTable = {
  appPreferences: appPreference,
  recordHeads: recordHead,
  deletionTombstones: deletionTombstone,
  commandReceipts: commandReceipt,
  eventWorkItems: storedWorkItem,
  eventConsumerReceipts: consumerReceipt,
  reverseDependencies: reverseDependency,
  engineEvaluationAudits: evaluationAudit,
};

describe("IMPLEMENTED_STORAGE_ROW_TABLES", () => {
  it("contains exactly the eight currently implemented row tables", () => {
    expect(IMPLEMENTED_STORAGE_ROW_TABLES).toEqual([
      "appPreferences",
      "recordHeads",
      "deletionTombstones",
      "commandReceipts",
      "eventWorkItems",
      "eventConsumerReceipts",
      "reverseDependencies",
      "engineEvaluationAudits",
    ]);
    expect(new Set(IMPLEMENTED_STORAGE_ROW_TABLES).size).toBe(8);
    expect(Object.isFrozen(IMPLEMENTED_STORAGE_ROW_TABLES)).toBe(true);
  });

  it("leaves the eight incomplete row tables outside the codec registry", () => {
    const deferred = JAGAON_TABLE_NAMES.filter(
      (table) => !IMPLEMENTED_STORAGE_ROW_TABLES.includes(table as never),
    );
    expect(deferred).toEqual([
      "recordRevisions",
      "auditEvents",
      "domainEvents",
      "aiInvocationAudits",
      "runtimeManifests",
      "governedAssets",
      "runtimeActivationAudits",
      "storageMetadata",
    ]);
  });
});

describe("implementedStorageRowCodecs", () => {
  it("is a frozen exact eight-codec map", () => {
    expect(Object.keys(implementedStorageRowCodecs)).toEqual(
      IMPLEMENTED_STORAGE_ROW_TABLES,
    );
    expect(Object.isFrozen(implementedStorageRowCodecs)).toBe(true);
  });

  for (const table of IMPLEMENTED_STORAGE_ROW_TABLES) {
    it(`${table} preserves a valid owning row at both boundaries`, () => {
      const codec = implementedStorageRowCodecs[table];
      const row = validRows[table];
      expect(codec.validateForWrite(row)).toEqual(row);
      expect(codec.validateAfterRead(row)).toEqual(row);
    });

    it(`${table} rejects an unknown field at both boundaries`, () => {
      const codec = implementedStorageRowCodecs[table];
      const row = { ...validRows[table], unknownField: true };
      expect(() => codec.validateForWrite(row)).toThrow(
        StorageRowValidationError,
      );
      expect(() => codec.validateAfterRead(row)).toThrow(
        StorageRowValidationError,
      );
    });
  }

  it.each([
    ["appPreferences", { ...appPreference, value: "fr-FR" }],
    ["recordHeads", { ...recordHead, recordId: "not-a-uuid" }],
    ["deletionTombstones", { ...deletionTombstone, initiator: "AI" }],
    ["commandReceipts", { ...commandReceipt, outcome: "MAYBE" }],
    ["eventWorkItems", { ...storedWorkItem, stateCode: "COMPLETED" }],
    ["eventConsumerReceipts", { ...consumerReceipt, consumer: "AI" }],
  ] as const)("%s rejects identity or discriminator corruption", (table, row) => {
    expect(() =>
      implementedStorageRowCodecs[table].validateAfterRead(row),
    ).toThrow(StorageRowValidationError);
  });
});
