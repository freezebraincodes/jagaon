import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { JAGAON_DEXIE_VERSION, JAGAON_TABLE_NAMES } from "@/storage/table-catalogue";
import type { RecordHead } from "@/domain/shared";
import {
  comparableSnapshotPayload,
  observationPayload,
  testUuid,
} from "@/domain/patterns/pattern-test-fixtures";
import {
  buildDerivedDeletionPlan,
  buildPatternCommitPlan,
  createIntelligenceCommandStore,
  IntelligencePlanError,
  type PatternCommitInput,
} from "./intelligence-persistence";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});

const databases: JagaOnDatabase[] = [];
afterEach(async () => {
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

async function openDatabase(): Promise<JagaOnDatabase> {
  const database = createJagaOnDatabase(`intelligence-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  return database;
}

const SNAPSHOT_RECORD = testUuid(800, 1);
const OBSERVATION_RECORD = testUuid(801, 1);
const PROVENANCE = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
let counter = 1000;
const next = () => testUuid((counter += 1), 5);

function revision(recordType: string, recordId: string, payload: unknown, previous: { revisionId: string; revisionNumber: number } | null, transactionId: string) {
  return {
    schemaVersion: 1,
    recordType,
    recordId,
    revisionId: next(),
    revisionNumber: previous ? previous.revisionNumber + 1 : 1,
    previousRevisionId: previous?.revisionId ?? null,
    action: previous ? "UPDATE" : "CREATE",
    recordedAt: "2026-10-03T16:00:00.000Z",
    revisionCreatedAt: "2026-10-03T16:00:00.000Z",
    temporal: { kind: "ATEMPORAL" },
    provenance: PROVENANCE,
    auditEventId: next(),
    transactionId,
    payload,
  };
}

function head(rev: { recordId: string; recordType: string; revisionId: string; revisionNumber: number }): RecordHead {
  return {
    recordId: rev.recordId,
    recordType: rev.recordType,
    headRevisionId: rev.revisionId,
    headRevisionNumber: rev.revisionNumber,
    state: "ACTIVE",
    updatedAt: "2026-10-03T16:00:00.000Z",
  } as RecordHead;
}

function evaluationAudit(transactionHint: string) {
  return {
    evaluationId: next(),
    engine: "PATTERN",
    evaluatorKey: "pattern.comparable-slot-trend",
    evaluatorVersion: "7a.1",
    configurationVersion: "comparable-slot-trend-config.v1",
    runtimeManifestId: "jagaon-hackathon-intelligence",
    runtimeManifestVersion: "7a.1",
    evaluatedAt: "2026-10-03T16:00:00.000Z",
    inputSequenceCutoff: 3,
    candidateKey: `COMPARABLE_SLOT_TREND:PATIENT_SELECTED_SLOT:BEFORE_BREAKFAST:${transactionHint}`,
    triggeringRevisions: [],
    consideredRevisions: [],
    inputFingerprint: "b".repeat(64),
    resultFingerprint: "c".repeat(64),
    dispositionKind: "RESULT",
    reasonCodes: ["PATTERN_OBSERVATION_CREATED"],
    limitationCodes: ["UNKNOWN_NEGATIVE_STATUS"],
    proposedEffectKeys: ["pattern:breakfast"],
  };
}

function firstPairInput(): PatternCommitInput {
  const transactionId = next();
  const snapshot = revision("PATTERN_EVIDENCE_SNAPSHOT", SNAPSHOT_RECORD, comparableSnapshotPayload(), null, transactionId);
  const observation = revision(
    "PATTERN_OBSERVATION",
    OBSERVATION_RECORD,
    {
      ...observationPayload("COMPARABLE_SLOT_TREND"),
      evidenceSnapshot: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: SNAPSHOT_RECORD, revisionId: snapshot.revisionId },
    },
    null,
    transactionId,
  );
  const evaluation = evaluationAudit("first");
  return {
    commandId: next(),
    correlationId: next(),
    transactionId,
    completedAt: "2026-10-03T16:00:00.000Z",
    snapshot: { kind: "NEW", revision: snapshot, expectedHead: null },
    observation: { revision: observation, expectedHead: null },
    eventIds: { snapshot: next(), observation: next() },
    reasonCode: "PATTERN_OBSERVATION_CREATED",
    evaluation,
    reverseDependencies: [
      {
        sourceRevisionId: testUuid(1, 2),
        dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
        dependentRecordId: SNAPSHOT_RECORD,
        dependentRevisionId: snapshot.revisionId,
        dependencyRole: "BASELINE_EVIDENCE",
        owner: "PATTERN_ENGINE",
        evaluatorKey: "pattern.comparable-slot-trend",
        evaluatorVersion: "7a.1",
        createdAt: "2026-10-03T16:00:00.000Z",
      },
      {
        sourceRevisionId: testUuid(11, 2),
        dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
        dependentRecordId: SNAPSHOT_RECORD,
        dependentRevisionId: snapshot.revisionId,
        dependencyRole: "RECENT_EVIDENCE",
        owner: "PATTERN_ENGINE",
        evaluatorKey: "pattern.comparable-slot-trend",
        evaluatorVersion: "7a.1",
        createdAt: "2026-10-03T16:00:00.000Z",
      },
    ],
  } as unknown as PatternCommitInput;
}

describe("Packet 7A derived persistence", () => {
  it("keeps the 16-table Dexie catalogue (schema version is Packet 10's frozen 2)", () => {
    expect(JAGAON_TABLE_NAMES).toHaveLength(16);
    expect(JAGAON_DEXIE_VERSION).toBe(2);
  });

  it("commits the snapshot before its observation with heads, edges, audit and events atomically", async () => {
    const database = await openDatabase();
    const store = createIntelligenceCommandStore(database);
    const input = firstPairInput();
    const receipt = await store.execute(buildPatternCommitPlan(input));
    expect(receipt.outcome).toBe("COMMITTED");

    const heads = await database.table("recordHeads").toArray();
    expect(heads.map((h) => h.recordType).sort()).toEqual(["PATTERN_EVIDENCE_SNAPSHOT", "PATTERN_OBSERVATION"]);
    const events = await database.table("domainEvents").orderBy("localSequence").toArray();
    expect(events.map((e) => e.eventName)).toEqual(["PATTERN_EVIDENCE_SNAPSHOT_CREATED", "PATTERN_OBSERVATION_CREATED"]);
    expect(await database.table("reverseDependencies").count()).toBe(2);
    expect(await database.table("engineEvaluationAudits").count()).toBe(1);
    expect(await database.table("recordRevisions").count()).toBe(2);
  });

  it("creates new immutable revisions on reevaluation and never edits earlier ones", async () => {
    const database = await openDatabase();
    const store = createIntelligenceCommandStore(database);
    const first = firstPairInput();
    await store.execute(buildPatternCommitPlan(first));
    const original = await database.table("recordRevisions").get(first.snapshot.revision.revisionId);

    const transactionId = next();
    const snapshot = revision("PATTERN_EVIDENCE_SNAPSHOT", SNAPSHOT_RECORD, comparableSnapshotPayload(), first.snapshot.revision, transactionId);
    const observation = revision(
      "PATTERN_OBSERVATION",
      OBSERVATION_RECORD,
      {
        ...observationPayload("COMPARABLE_SLOT_TREND"),
        evidenceSnapshot: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: SNAPSHOT_RECORD, revisionId: snapshot.revisionId },
      },
      first.observation.revision,
      transactionId,
    );
    const second = {
      ...first,
      commandId: next(),
      transactionId,
      snapshot: { kind: "NEW", revision: snapshot, expectedHead: head(first.snapshot.revision) },
      observation: { revision: observation, expectedHead: head(first.observation.revision) },
      eventIds: { snapshot: next(), observation: next() },
      reasonCode: "PATTERN_OBSERVATION_REVISED",
      evaluation: evaluationAudit("second"),
      reverseDependencies: first.reverseDependencies.map((edge) => ({ ...edge, dependentRevisionId: snapshot.revisionId })),
    } as unknown as PatternCommitInput;
    expect((await store.execute(buildPatternCommitPlan(second))).outcome).toBe("COMMITTED");
    expect(await database.table("recordRevisions").get(first.snapshot.revision.revisionId)).toEqual(original);
    expect(await database.table("recordRevisions").count()).toBe(4);
    const events = await database.table("domainEvents").orderBy("localSequence").toArray();
    expect(events.slice(2).map((e) => e.eventName)).toEqual(["PATTERN_EVIDENCE_SNAPSHOT_CREATED", "PATTERN_OBSERVATION_REVISED"]);
  });

  it("allows a lifecycle-only observation revision to reuse the exact snapshot", async () => {
    const database = await openDatabase();
    const store = createIntelligenceCommandStore(database);
    const first = firstPairInput();
    await store.execute(buildPatternCommitPlan(first));
    const transactionId = next();
    const observation = revision(
      "PATTERN_OBSERVATION",
      OBSERVATION_RECORD,
      {
        ...observationPayload("COMPARABLE_SLOT_TREND", {
          state: "WEAKENING",
          previouslySupported: {
            recordType: "PATTERN_OBSERVATION",
            recordId: OBSERVATION_RECORD,
            revisionId: first.observation.revision.revisionId,
          },
        }),
        evidenceSnapshot: first.observation.revision.payload.evidenceSnapshot,
      },
      first.observation.revision,
      transactionId,
    );
    const plan = buildPatternCommitPlan({
      ...first,
      commandId: next(),
      transactionId,
      snapshot: { kind: "REUSED", revision: first.snapshot.revision },
      observation: { revision: observation, expectedHead: head(first.observation.revision) },
      eventIds: { observation: next() },
      reasonCode: "PATTERN_OBSERVATION_TRANSITIONED",
      evaluation: evaluationAudit("third"),
      reverseDependencies: [],
    } as unknown as PatternCommitInput);
    expect((await store.execute(plan)).outcome).toBe("COMMITTED");
    expect(await database.table("recordRevisions").count()).toBe(3);
    const events = await database.table("domainEvents").orderBy("localSequence").toArray();
    expect(events.at(-1)?.eventName).toBe("PATTERN_OBSERVATION_TRANSITIONED");
  });

  it("rejects a partial pair, a family mismatch, an unsupported version and duplicate edges before commit", () => {
    const input = firstPairInput();
    const otherSnapshot = { ...input.observation.revision.payload, evidenceSnapshot: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: SNAPSHOT_RECORD, revisionId: testUuid(5, 9) } };
    expect(() =>
      buildPatternCommitPlan({ ...input, observation: { ...input.observation, revision: { ...input.observation.revision, payload: otherSnapshot } } } as never),
    ).toThrow(IntelligencePlanError);

    const familiar = { ...observationPayload("FAMILIAR_OR_FREQUENT_ITEM"), evidenceSnapshot: input.observation.revision.payload.evidenceSnapshot };
    expect(() =>
      buildPatternCommitPlan({ ...input, observation: { ...input.observation, revision: { ...input.observation.revision, payload: familiar } } } as never),
    ).toThrow(IntelligencePlanError);

    const unsupported = {
      ...input.snapshot.revision.payload,
      ruleVersions: { ...(input.snapshot.revision.payload as { ruleVersions: object }).ruleVersions, evidenceGateVersion: "comparable-slot-gate.v9" },
    };
    expect(() =>
      buildPatternCommitPlan({ ...input, snapshot: { ...input.snapshot, revision: { ...input.snapshot.revision, payload: unsupported } } } as never),
    ).toThrow(IntelligencePlanError);

    expect(() =>
      buildPatternCommitPlan({ ...input, reverseDependencies: [...input.reverseDependencies, input.reverseDependencies[0]] } as never),
    ).toThrow(IntelligencePlanError);

    expect(() =>
      buildPatternCommitPlan({
        ...input,
        reverseDependencies: [{ ...input.reverseDependencies[0], dependentRevisionId: testUuid(9, 9) }],
      } as never),
    ).toThrow(IntelligencePlanError);
  });

  it("rejects a stale expected head without writing anything", async () => {
    const database = await openDatabase();
    const store = createIntelligenceCommandStore(database);
    await store.execute(buildPatternCommitPlan(firstPairInput()));
    const before = await database.table("recordRevisions").count();
    const replay = { ...firstPairInput(), commandId: next() } as unknown as PatternCommitInput;
    const receipt = await store.execute(buildPatternCommitPlan(replay));
    expect(receipt.outcome).toBe("REJECTED");
    expect(await database.table("recordRevisions").count()).toBe(before);
    expect(await database.table("reverseDependencies").count()).toBe(2);
  });

  it("deletes derived chains by tombstone and purges their sensitive revisions and edges", async () => {
    const database = await openDatabase();
    const store = createIntelligenceCommandStore(database);
    const first = firstPairInput();
    await store.execute(buildPatternCommitPlan(first));
    const plan = buildDerivedDeletionPlan({
      commandId: next(),
      correlationId: next(),
      transactionId: next(),
      completedAt: "2026-10-04T00:00:00.000Z",
      reasonCode: "PATTERN_DERIVED_CONTENT_DELETED",
      targets: [
        { head: head(first.snapshot.revision), auditEventId: next(), eventId: next() },
        { head: head(first.observation.revision), auditEventId: next(), eventId: next() },
      ],
    } as never);
    expect((await store.execute(plan)).outcome).toBe("COMMITTED");
    expect(await database.table("recordRevisions").count()).toBe(0);
    expect(await database.table("reverseDependencies").count()).toBe(0);
    expect(await database.table("deletionTombstones").count()).toBe(2);
    const heads = await database.table("recordHeads").toArray();
    expect(heads.every((h) => h.state === "DELETED")).toBe(true);
  });
});
