import type { Instant, RecordHead, RecordId, RecordType } from "@/domain/shared";
import type { JagaOnDatabase } from "@/storage/database";
import { createPopulatedDataset, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { readDatasetTables } from "@/application/storage/integrity-gate";
import { createPermanentDeletionService } from "./permanent-deletion-service";

/** Test-only Packet 10A deletion fixture over a real populated dataset. */

const uuid = () => crypto.randomUUID() as never;
export const deletionIds = { commandId: uuid, correlationId: uuid, transactionId: uuid, auditEventId: uuid, domainEventId: uuid, workItemId: uuid };

export async function createDeletionFixture() {
  const { name, runtime } = await createPopulatedDataset();
  runtime.close();
  const database = await openRaw(name);
  let clock: Instant = PACKET10_NOW;
  const service = createPermanentDeletionService(database, { now: () => clock, ids: deletionIds });
  const tables = () => readDatasetTables(database);
  const edges = async () => (await tables()).reverseDependencies as Array<{ sourceRevisionId: string; dependentRecordId: string; dependentRecordType: string }>;
  const revisions = async () => (await tables()).recordRevisions as Array<{ recordId: string; recordType: string; revisionId: string; revisionNumber: number }>;

  /** The target record of `type` whose revisions are the source of an edge to `dependentType`. */
  async function targetWithDependent(type: RecordType, dependentType: string): Promise<{ recordType: RecordType; recordId: RecordId }> {
    const rows = await revisions();
    const sources = new Set((await edges()).filter((edge) => edge.dependentRecordType === dependentType).map((edge) => edge.sourceRevisionId));
    const row = rows.find((revision) => revision.recordType === type && sources.has(revision.revisionId));
    if (!row) throw new Error(`no ${type} with ${dependentType}`);
    return { recordType: type, recordId: row.recordId as RecordId };
  }

  async function head(recordId: string): Promise<RecordHead | undefined> {
    return (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
  }

  return {
    name,
    database: database as JagaOnDatabase,
    service,
    tables,
    revisions,
    edges,
    head,
    targetWithDependent,
    setClock: (value: string) => (clock = value as Instant),
  };
}
