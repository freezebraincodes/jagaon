import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { canonicaliseBackupTable, createBackupManifest } from "@/backup/backup-canonicalisation";
import { createBackupExportService } from "@/backup/backup-export-service";
import type { BackupTableSetV1 } from "@/backup/backup-payload-v1";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer, sealForTest } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createStorageMetadataRepository } from "@/storage/storage-metadata";
import { learnedKnowledgeDependencySources } from "@/application/intelligence/learning-dependencies";
import type { LearnedKnowledgeEvidence } from "@/domain/learning";
import { expectedReverseDependencies } from "./dependency-reconstruction";
import { currentDatasetFingerprint } from "./restore-planner";
import { createRestoreReconciler } from "./restore-reconciler";
import { createRestoreService } from "./restore-service";

/**
 * Packet 10 Corrective Pass B: a backup whose reverse-dependency edges are
 * missing, surplus, duplicated or carry the wrong governed fields is rejected
 * before any destructive replacement, at every pre-destructive checkpoint,
 * and the current dataset stays byte-identical.
 */

// Lets a test skip earlier checkpoints to prove a later one still refuses.
const bypass = vi.hoisted(() => ({ on: false }));
vi.mock("./dependency-reconstruction", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return { ...actual, validateReverseDependencies: (...args: unknown[]) => (bypass.on ? { kind: "VALID" } : actual.validateReverseDependencies!(...args)) };
});

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const names: string[] = [];
afterEach(async () => {
  bypass.on = false;
  for (const name of names.splice(0)) await Dexie.delete(name);
});

type Edge = Record<string, string>;
type Revision = { recordId: string; recordType: string; revisionId: string };
type Tables = Record<string, unknown[]>;

/** A same-lineage backup of a populated dataset whose edges `mutate` corrupts; manifests are recomputed so only the edge contract is wrong. */
async function malformedBackup(mutate: (edges: Edge[], revisions: Revision[]) => Edge[], mutateTables: (tables: Tables) => void = () => undefined) {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  const capture = capturingFilePort();
  await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  database.close();
  const payload = (await decryptForTest(parseContainer(capture.saved[0]!.bytes), PASS)) as { containerId: string; tables: BackupTableSetV1; tableManifests: unknown };
  const tables = payload.tables as unknown as Tables;
  // Canonical order over distinct rows; an exact duplicate stays beside its original.
  const mutated = mutate(structuredClone(tables.reverseDependencies) as Edge[], tables.recordRevisions as Revision[]);
  const occurrences = new Map<string, number>();
  for (const row of mutated) occurrences.set(canonicalizeJson(row), (occurrences.get(canonicalizeJson(row)) ?? 0) + 1);
  const distinct = [...occurrences.keys()].map((key) => JSON.parse(key) as Edge);
  tables.reverseDependencies = canonicaliseBackupTable("reverseDependencies", distinct).flatMap((row) => Array(occurrences.get(canonicalizeJson(row))!).fill(row));
  mutateTables(tables);
  for (const table of Object.keys(tables)) if (table !== "reverseDependencies") tables[table] = canonicaliseBackupTable(table as never, tables[table]!);
  payload.tableManifests = await createBackupManifest(payload.tables, (data) => createWebCryptoPort().sha256(data));
  const file = await sealForTest(canonicalizeJson(payload), PASS, payload.containerId);
  const snapshot = async () => {
    const raw = await openRaw(name);
    const all = await readAllTables(raw);
    raw.close();
    return { all, fingerprint: currentDatasetFingerprint(all) };
  };
  return { name, file, snapshot };
}

function service(name: string, closeRuntime: () => void = () => undefined) {
  return createRestoreService({
    databaseName: name,
    now: () => LATER as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
    closeRuntime,
  });
}

const learnedEdge = (edges: Edge[]) => edges.find((edge) => edge.dependentRecordType === "LEARNED_KNOWLEDGE")!;

/** Closed set of malformed candidates; each is schema-valid and every reference resolves. */
const CASES: Array<[string, (edges: Edge[], revisions: Revision[]) => Edge[]]> = [
  ["A missing edge", (edges) => edges.filter((edge) => edge !== learnedEdge(edges))],
  [
    "B extra edge from a validly referenced but unjustified source",
    (edges, revisions) => {
      const edge = learnedEdge(edges);
      const source = revisions.find((row) => row.recordType === "GLUCOSE_READING" && !edges.some((other) => other.sourceRevisionId === row.revisionId && other.dependentRevisionId === edge.dependentRevisionId))!;
      return [...edges, { ...edge, sourceRevisionId: source.revisionId }];
    },
  ],
  ["B extra edge in a registered but unjustified role", (edges) => [...edges, { ...learnedEdge(edges), dependencyRole: "CONTRADICTING_EVIDENCE" }]],
  ["B duplicated edge", (edges) => [...edges, { ...learnedEdge(edges) }]],
  [
    "C evaluator key of another evaluator for the same dependent type and role",
    (edges) => {
      const index = edges.findIndex((edge) => edge.dependencyRole === "CONSIDERED_EXCLUDED");
      const edge = edges[index]!;
      const other = edge.evaluatorKey === "pattern.comparable-slot-trend" ? "pattern.familiar-or-frequent-item" : "pattern.comparable-slot-trend";
      return edges.map((row, at) => (at === index ? { ...row, evaluatorKey: other } : row));
    },
  ],
  ["C createdAt not the dependent revision's creation instant", (edges) => edges.map((row) => (row === learnedEdge(edges) ? { ...row, createdAt: "2026-10-01T00:00:00.000Z" } : row))],
  [
    "C dependent record of another record",
    (edges, revisions) => {
      const edge = learnedEdge(edges);
      const other = revisions.find((row) => row.recordType === "LEARNED_KNOWLEDGE" && row.recordId !== edge.dependentRecordId)!;
      return edges.map((row) => (row === edge ? { ...row, dependentRecordId: other.recordId } : row));
    },
  ],
];

describe("malformed reverse dependencies are rejected before destructive replacement (Pass B)", () => {
  it(
    "control: the unmodified, resealed candidate passes every checkpoint and commits",
    async () => {
      const h = await malformedBackup((edges) => edges);
      const restore = service(h.name);
      const inspected = await restore.inspect(h.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      expect((await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).kind).toBe("COMMITTED");
    },
    TIMEOUT,
  );

  it.each(CASES)(
    "inspection rejects: %s",
    async (_label, mutate) => {
      const h = await malformedBackup(mutate);
      const before = await h.snapshot();
      const result = await service(h.name).inspect(h.file, PASS);
      expect(result.kind === "FAILED" && result.failure.errorCode).toBe("BACKUP_PAYLOAD_INVALID");
      expect(await h.snapshot()).toEqual(before);
    },
    TIMEOUT,
  );

  it.each(CASES.slice(0, 2).concat(CASES.slice(4, 6)))(
    "confirmation revalidates the private plan before any lock or runtime closure: %s",
    async (_label, mutate) => {
      const h = await malformedBackup(mutate);
      const closeRuntime = vi.fn();
      const restore = service(h.name, closeRuntime);
      bypass.on = true;
      const inspected = await restore.inspect(h.file, PASS);
      bypass.on = false;
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      const before = await h.snapshot();
      const result = await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never });
      expect(result.kind).not.toBe("COMMITTED");
      expect(closeRuntime).not.toHaveBeenCalled();
      expect(await h.snapshot()).toEqual(before);
    },
    TIMEOUT,
  );

  it.each(CASES.slice(0, 2).concat(CASES.slice(4, 6)))(
    "the restore transaction revalidates before clearing any table: %s",
    async (_label, mutate) => {
      const h = await malformedBackup(mutate);
      bypass.on = true;
      // The lock is held and this tab's runtime is closed: only the in-transaction check remains.
      const restore = service(h.name, () => (bypass.on = false));
      const inspected = await restore.inspect(h.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      const before = await h.snapshot();
      const result = await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never });
      expect(bypass.on).toBe(false);
      expect(result.kind).toBe("STALE");
      const after = await h.snapshot();
      expect(after).toEqual(before);
      const database = await openRaw(h.name);
      expect(await createStorageMetadataRepository(database).readRestoreState()).toBeNull();
      database.close();
    },
    TIMEOUT,
  );
});

describe("audit and transaction linkage of a restore candidate (Pass B item 4)", () => {
  const CASES_AUDIT: Array<[string, (tables: Tables) => void]> = [
    [
      "a revision whose audit event belongs to another revision",
      (tables) => {
        // The row envelope stays self-consistent so only the audit linkage is wrong.
        const rows = tables.recordRevisions as Array<{ auditEventId: string; revision: { auditEventId: string } }>;
        const [first, second] = [rows[0]!, rows.find((row) => row.auditEventId !== rows[0]!.auditEventId)!];
        first.auditEventId = first.revision.auditEventId = second.auditEventId;
      },
    ],
    [
      "a committed receipt naming an audit event of another transaction",
      (tables) => {
        const receipts = tables.commandReceipts as Array<{ transactionId: string; auditEventIds: string[] }>;
        const other = receipts.find((receipt) => receipt.transactionId !== receipts[0]!.transactionId)!;
        receipts[0]!.auditEventIds = [...receipts[0]!.auditEventIds, ...other.auditEventIds].sort();
      },
    ],
  ];

  it.each(CASES_AUDIT)(
    "inspection rejects %s and leaves the dataset unchanged",
    async (_label, mutateTables) => {
      const h = await malformedBackup((edges) => edges, mutateTables);
      const before = await h.snapshot();
      const result = await service(h.name).inspect(h.file, PASS);
      expect(result.kind === "FAILED" && result.failure.errorCode).toBe("BACKUP_PAYLOAD_INVALID");
      expect(await h.snapshot()).toEqual(before);
    },
    TIMEOUT,
  );
});

describe("post-commit reconciliation compares every governed edge field (Pass B defence in depth)", () => {
  async function reconcilingWith(change: (edge: Edge, edges: Edge[]) => Edge) {
    const { name, runtime } = await createPopulatedDataset();
    names.push(name);
    runtime.close();
    const database = await openRaw(name);
    const edges = (await database.table("reverseDependencies").toArray()) as Edge[];
    const edge = edges.find((row) => row.dependencyRole === "CONSIDERED_EXCLUDED")!;
    await database.table("reverseDependencies").put(change(edge, edges) as never);
    await createStorageMetadataRepository(database).writeRestoreState({
      key: "RESTORE_STATE",
      phase: "RECONCILING",
      operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
      restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
      planHash: "a".repeat(64),
      committedAt: PACKET10_NOW,
      lastCompletedStep: "COMMITTED",
    });
    const owners = { rebuildBootstrapLocale: vi.fn(async () => undefined), inquiryMaintenance: vi.fn(async () => undefined), patternLearningRefresh: vi.fn(async () => undefined), reminderReconciliation: vi.fn(async () => undefined), careSummaryInvalidation: vi.fn(async () => undefined) };
    const result = await createRestoreReconciler(database, { now: () => PACKET10_NOW, owners }).resume();
    const state = await createStorageMetadataRepository(database).readRestoreState();
    database.close();
    return { result, state, owners };
  }

  it(
    "a same-key edge with another evaluator key blocks reconciliation",
    async () => {
      const { result, state, owners } = await reconcilingWith((edge) => ({ ...edge, evaluatorKey: edge.evaluatorKey === "pattern.comparable-slot-trend" ? "pattern.familiar-or-frequent-item" : "pattern.comparable-slot-trend" }));
      expect(result.kind).toBe("FAILED");
      expect(state).toMatchObject({ phase: "FAILED_BLOCKING" });
      expect(owners.rebuildBootstrapLocale).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "a same-key edge with another creation instant blocks reconciliation",
    async () => {
      const { result, state } = await reconcilingWith((edge) => ({ ...edge, createdAt: "2026-10-01T00:00:00.000Z" }));
      expect(result.kind).toBe("FAILED");
      expect(state).toMatchObject({ phase: "FAILED_BLOCKING" });
    },
    TIMEOUT,
  );
});

describe("LEARNED_KNOWLEDGE writer and reconstruction share one rule (Pass B item 3)", () => {
  const ref = (n: number) => ({ recordType: "ACTIVITY_EVENT", recordId: `00000000-0000-4000-8000-00000000000${n}`, revisionId: `00000000-0000-4000-9000-00000000000${n}` });
  const evidence = {
    kind: "OBSERVATION_SET",
    supportingRevisions: [ref(1), ref(2)],
    contradictingRevisions: [ref(3)],
    distinctOccasionCount: 2,
    assessmentPolicyVersion: "familiar-item-learning-policy.v1",
    evaluationRuleVersion: "familiar-item-learning-rule.v1",
  } as unknown as LearnedKnowledgeEvidence;

  it("persists supporting and contradicting evidence as registered roles", () => {
    expect(learnedKnowledgeDependencySources(evidence)).toEqual([
      { revisionId: ref(1).revisionId, role: "SUPPORTING_EVIDENCE" },
      { revisionId: ref(2).revisionId, role: "SUPPORTING_EVIDENCE" },
      { revisionId: ref(3).revisionId, role: "CONTRADICTING_EVIDENCE" },
    ]);
    // A direct statement's related revisions have no registered role.
    expect(learnedKnowledgeDependencySources({ kind: "DIRECT_PATIENT_STATEMENT", relatedRevisions: [ref(1)], contradictingRevisions: [ref(3)], assessmentPolicyVersion: "p", evaluationRuleVersion: "r" } as unknown as LearnedKnowledgeEvidence)).toEqual([
      { revisionId: ref(3).revisionId, role: "CONTRADICTING_EVIDENCE" },
    ]);
  });

  it("reconstruction expects the exact governed fields for every learned source", () => {
    const row = { recordType: "LEARNED_KNOWLEDGE", recordId: "00000000-0000-4000-8000-0000000000aa", revisionId: "00000000-0000-4000-9000-0000000000aa", revisionNumber: 1, revision: { revisionCreatedAt: PACKET10_NOW, payload: { evidence } } };
    const expected = [...expectedReverseDependencies([row]).values()];
    expect(expected.map((edge) => edge.dependencyRole)).toEqual(["SUPPORTING_EVIDENCE", "SUPPORTING_EVIDENCE", "CONTRADICTING_EVIDENCE"]);
    for (const edge of expected) {
      expect(edge).toMatchObject({ dependentRecordType: "LEARNED_KNOWLEDGE", dependentRecordId: row.recordId, dependentRevisionId: row.revisionId, owner: "LEARNING_ENGINE", evaluatorKey: "learning.familiar-item", createdAt: PACKET10_NOW });
    }
  });
});
