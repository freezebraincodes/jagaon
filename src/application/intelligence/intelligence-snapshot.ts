import type { Table } from "dexie";
import { validatePacket6StoredRevision } from "@/application/journal/journal-row-codecs";
import { eventSequenceHighWaterMarkRowCodec } from "@/storage/event-sequence-metadata";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import type { JagaOnDatabase } from "@/storage/database";
import type { RecordHead } from "@/domain/shared";
import type { Instant } from "@/domain/shared/time";
import type { LearnedKnowledgeRevision } from "@/domain/learning";
import type { PatternEvidenceSnapshotRevision, PatternObservationRevision } from "@/domain/patterns";
import type {
  PreviousPatternChain,
  ResolvedActivityEvent,
  ResolvedGlucoseReading,
  ResolvedIntakeEvent,
  SupersededRevision,
} from "@/patterns/pattern-evaluator-contracts";
import { comparableSlotCandidateKey } from "@/patterns/comparable-slot-trend-evaluator";
import { familiarItemCandidateKey } from "@/patterns/familiar-or-frequent-item-evaluator";
import { familiarLearningCandidateKey } from "@/learning/familiar-item-learning-evaluator";
import { derivedRevisionRowCodec } from "./derived-record-codecs";
import { addDays } from "./metrics";
import {
  COMPARABLE_SLOT_TREND_CONFIG_V1,
  FAMILIAR_ITEM_LEARNING_CONFIG_V1,
  FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1,
} from "./activation-manifest";

/**
 * One consistent read of everything the enabled Packet 7A evaluators need at
 * a stable sequence cutoff (deterministic-engine Section 3.1). Only latest
 * valid source revisions inside each family's bounded window are resolved;
 * earlier revisions of those records are returned as superseded. Any
 * integrity failure aborts the evaluation rather than producing a partial view.
 */

export class IntelligenceIntegrityError extends Error {
  readonly name = "IntelligenceIntegrityError";
  constructor() {
    super("INTEGRITY_CHECK_FAILED");
  }
}

export type PatternChainState = {
  observationHead: RecordHead;
  snapshotHead: RecordHead;
  /** Current snapshot-chain head revision (expected head for a new snapshot). */
  snapshotHeadRevision: PatternEvidenceSnapshotRevision;
  previous: PreviousPatternChain;
};

export type LearningChainState = { head: RecordHead; revision: LearnedKnowledgeRevision };

export type IntelligenceSnapshot = {
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  glucose: ResolvedGlucoseReading[];
  glucoseSuperseded: SupersededRevision[];
  intakeEvents: ResolvedIntakeEvent[];
  activityEvents: ResolvedActivityEvent[];
  eventSuperseded: SupersededRevision[];
  patternChains: Map<string, PatternChainState>;
  /** Snapshot record ID → candidate key, for reverse-dependency fan-out. */
  candidateBySnapshotRecord: Map<string, string>;
  learningChains: Map<string, LearningChainState>;
  candidateByLearnedRecord: Map<string, string>;
};

type StoredRow = Record<string, unknown> & { revisionId: string; recordId: string };

function integrity<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new IntelligenceIntegrityError();
  }
}

async function latestInWindow(
  revisions: Table<StoredRow>,
  heads: Table<RecordHead>,
  recordType: string,
  start: Instant,
  end: Instant,
): Promise<{ latest: ReturnType<typeof validatePacket6StoredRevision>[]; superseded: SupersededRevision[] }> {
  const indexes = ["[recordType+occurrenceSortInstant]", "[recordType+effectiveStartSortInstant]"];
  const rows: StoredRow[] = [];
  for (const index of indexes) {
    rows.push(...(await revisions.where(index).between([recordType, start], [recordType, end], true, false).toArray()));
  }
  const recordIds = [...new Set(rows.map((row) => row.recordId))];
  const headRows = recordIds.length > 0 ? await heads.where("recordId").anyOf(recordIds).toArray() : [];
  const headByRecord = new Map<string, RecordHead>(
    headRows.map((raw) => {
      const head = integrity(() => implementedStorageRowCodecs.recordHeads.validateAfterRead(raw));
      return [head.recordId, head] as const;
    }),
  );
  const latest: ReturnType<typeof validatePacket6StoredRevision>[] = [];
  const superseded: SupersededRevision[] = [];
  const included = new Set<string>();
  for (const row of rows) {
    const head = headByRecord.get(row.recordId);
    if (!head || head.state !== "ACTIVE") continue;
    if (row.revisionId === head.headRevisionId && !included.has(row.revisionId)) {
      included.add(row.revisionId);
      latest.push(integrity(() => validatePacket6StoredRevision(row)));
    }
  }
  const includedRecords = new Set(latest.map((stored) => stored.recordId));
  // Earlier revisions of included records, read in full so corrections are traceable.
  if (includedRecords.size > 0) {
    const history = await revisions.where("recordId").anyOf([...includedRecords]).toArray();
    for (const row of history) {
      const head = headByRecord.get(row.recordId);
      if (head && row.revisionId !== head.headRevisionId) {
        superseded.push({ ref: { recordType: recordType as never, recordId: row.recordId as never, revisionId: row.revisionId as never } });
      }
    }
  }
  return { latest, superseded };
}

function asResolved<T>(stored: ReturnType<typeof validatePacket6StoredRevision>): T {
  const revision = stored.revision;
  return {
    ref: { recordType: revision.recordType, recordId: revision.recordId, revisionId: revision.revisionId },
    revisionNumber: revision.revisionNumber,
    action: revision.action,
    provenance: revision.provenance,
    temporal: revision.temporal,
    payload: revision.payload,
  } as unknown as T;
}

export async function loadIntelligenceSnapshot(database: JagaOnDatabase, evaluatedAt: Instant): Promise<IntelligenceSnapshot> {
  const revisions = database.table<StoredRow>("recordRevisions");
  const heads = database.table<RecordHead>("recordHeads");
  const metadata = database.table("storageMetadata");

  return database.transaction("r", revisions, heads, metadata, async () => {
    const rawMark = await metadata.get("EVENT_SEQUENCE_HIGH_WATER_MARK");
    const inputSequenceCutoff =
      rawMark === undefined ? 0 : integrity(() => eventSequenceHighWaterMarkRowCodec.validateAfterRead(rawMark)).lastAllocatedSequence;

    const glucose = await latestInWindow(
      revisions,
      heads,
      "GLUCOSE_READING",
      addDays(evaluatedAt, -COMPARABLE_SLOT_TREND_CONFIG_V1.referenceWindowStartDays),
      evaluatedAt,
    );
    const eventWindowStart = addDays(
      evaluatedAt,
      -Math.max(FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1.sourceWindowDays, FAMILIAR_ITEM_LEARNING_CONFIG_V1.sourceWindowDays),
    );
    const intakes = await latestInWindow(revisions, heads, "INTAKE_EVENT", eventWindowStart, evaluatedAt);
    const activities = await latestInWindow(revisions, heads, "ACTIVITY_EVENT", eventWindowStart, evaluatedAt);

    // Current derived chains.
    const patternChains = new Map<string, PatternChainState>();
    const candidateBySnapshotRecord = new Map<string, string>();
    const observationHeads = (await heads.where("recordType").equals("PATTERN_OBSERVATION").toArray())
      .map((raw) => integrity(() => implementedStorageRowCodecs.recordHeads.validateAfterRead(raw)))
      .filter((head) => head.state === "ACTIVE");
    for (const observationHead of observationHeads) {
      const observationRow = await revisions.get(observationHead.headRevisionId);
      if (!observationRow) throw new IntelligenceIntegrityError();
      const observation = integrity(() => derivedRevisionRowCodec.validateAfterRead(observationRow)).revision as PatternObservationRevision;
      const reference = observation.payload.evidenceSnapshot;
      const snapshotRow = await revisions.get(reference.revisionId);
      const snapshotHeadRaw = await heads.get(reference.recordId);
      if (!snapshotRow || !snapshotHeadRaw) throw new IntelligenceIntegrityError();
      const snapshotHead = integrity(() => implementedStorageRowCodecs.recordHeads.validateAfterRead(snapshotHeadRaw));
      const snapshot = integrity(() => derivedRevisionRowCodec.validateAfterRead(snapshotRow)).revision as PatternEvidenceSnapshotRevision;
      const headRow = snapshotHead.headRevisionId === snapshot.revisionId ? snapshotRow : await revisions.get(snapshotHead.headRevisionId);
      if (!headRow) throw new IntelligenceIntegrityError();
      const snapshotHeadRevision = integrity(() => derivedRevisionRowCodec.validateAfterRead(headRow)).revision as PatternEvidenceSnapshotRevision;
      const claim = observation.payload.claim;
      const key =
        claim.family === "COMPARABLE_SLOT_TREND"
          ? comparableSlotCandidateKey(claim.slot)
          : claim.family === "FAMILIAR_OR_FREQUENT_ITEM"
            ? familiarItemCandidateKey(claim.item.familiarItemKey)
            : null;
      if (key === null) continue; // Disabled families are never evaluated here.
      patternChains.set(key, { observationHead, snapshotHead, snapshotHeadRevision, previous: { observation, snapshot } });
      candidateBySnapshotRecord.set(snapshotHead.recordId, key);
    }

    const learningChains = new Map<string, LearningChainState>();
    const candidateByLearnedRecord = new Map<string, string>();
    const learnedHeads = (await heads.where("recordType").equals("LEARNED_KNOWLEDGE").toArray())
      .map((raw) => integrity(() => implementedStorageRowCodecs.recordHeads.validateAfterRead(raw)))
      .filter((head) => head.state === "ACTIVE");
    for (const head of learnedHeads) {
      const row = await revisions.get(head.headRevisionId);
      if (!row) throw new IntelligenceIntegrityError();
      const revision = integrity(() => derivedRevisionRowCodec.validateAfterRead(row)).revision as LearnedKnowledgeRevision;
      if (revision.payload.content.kind !== "FAMILIAR_ITEM") continue;
      const key = familiarLearningCandidateKey(revision.payload.content.item.familiarItemKey);
      learningChains.set(key, { head, revision });
      candidateByLearnedRecord.set(head.recordId, key);
    }

    return {
      evaluatedAt,
      inputSequenceCutoff,
      glucose: glucose.latest.map((stored) => asResolved<ResolvedGlucoseReading>(stored)),
      glucoseSuperseded: glucose.superseded,
      intakeEvents: intakes.latest.map((stored) => asResolved<ResolvedIntakeEvent>(stored)),
      activityEvents: activities.latest.map((stored) => asResolved<ResolvedActivityEvent>(stored)),
      eventSuperseded: [...intakes.superseded, ...activities.superseded],
      patternChains,
      candidateBySnapshotRecord,
      learningChains,
      candidateByLearnedRecord,
    };
  });
}
