import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime, JagaOnStorageLockedError } from "@/application/journal/browser-journal-runtime";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { verifyDataset } from "@/storage/dataset-verifier";
import { createIntegrityGate, IntegrityLockedError, openVerifiedDataset, readDatasetTables } from "./integrity-gate";
import { HACKATHON_CLOSED_ROW_CODECS } from "./profile-row-codecs";
import { createPopulatedDataset, openRaw, PACKET10_NOW, installFakeIndexedDb } from "./packet10-test-support";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 60_000;
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const ports = { now: () => PACKET10_NOW, newDatasetIdentity: () => crypto.randomUUID(), blockedTimeoutMs: 50 };

async function populatedName(): Promise<string> {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  return name;
}

async function corrupt(name: string, mutate: (database: Awaited<ReturnType<typeof openRaw>>) => Promise<void>) {
  const database = await openRaw(name);
  await mutate(database);
  database.close();
}

describe("dataset verification and integrity lock (spec 5.7, 9.4; FAIL-003)", () => {
  it(
    "verifies a populated dataset and reopens it without seeding again",
    async () => {
      const name = await populatedName();
      const opened = await openVerifiedDataset(name, ports);
      expect(opened.kind).toBe("READY");
      if (opened.kind !== "READY") return;
      expect(opened.lifecycle).toBe("EXISTING");
      const tables = await readDatasetTables(opened.database);
      opened.database.close();
      expect(verifyDataset(tables, HACKATHON_CLOSED_ROW_CODECS)).toMatchObject({ kind: "VERIFIED" });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "locks on an invalid row, a broken chain, retained deleted content or a short sequence high-water mark",
    async () => {
      const name = await populatedName();
      const database = await openRaw(name);
      const tables = await readDatasetTables(database);
      database.close();
      const verify = (mutate: (copy: typeof tables) => void) => {
        const copy = structuredClone(tables);
        mutate(copy);
        return verifyDataset(copy, HACKATHON_CLOSED_ROW_CODECS);
      };
      expect(verify((copy) => (copy.auditEvents[0] = { ...(copy.auditEvents[0] as object), note: "x" }))).toEqual({ kind: "FAILED", invariant: "ROW_SCHEMA", tableName: "auditEvents" });
      const corrected = (copy: typeof tables) =>
        (copy.recordRevisions as Array<{ recordId: string; revisionNumber: number }>).find((row) => row.revisionNumber === 2)!.recordId;
      expect(
        verify((copy) => {
          const recordId = corrected(copy);
          copy.recordRevisions = (copy.recordRevisions as Array<{ recordId: string; revisionNumber: number }>).filter((row) => !(row.recordId === recordId && row.revisionNumber === 1));
        }),
      ).toMatchObject({ kind: "FAILED", invariant: "REVISION_CHAIN" });
      expect(
        verify((copy) => {
          const head = copy.recordHeads[0] as { state: string };
          head.state = "DELETED";
        }),
      ).toMatchObject({ kind: "FAILED", invariant: "TOMBSTONE_HEAD" });
      expect(
        verify((copy) => {
          const head = copy.recordHeads[0] as { recordId: string; recordType: string; state: string };
          const audit = copy.auditEvents[0] as { auditEventId: string; transactionId: string };
          head.state = "DELETED";
          copy.deletionTombstones = [
            { recordId: head.recordId, recordType: head.recordType, deletedAt: PACKET10_NOW, initiator: "PATIENT", auditEventId: audit.auditEventId, transactionId: audit.transactionId },
          ];
        }),
      ).toEqual({ kind: "FAILED", invariant: "DELETED_CONTENT_RETAINED", tableName: "recordRevisions" });
      expect(
        verify((copy) => {
          const row = copy.storageMetadata.find((entry) => (entry as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK") as { lastAllocatedSequence: number };
          row.lastAllocatedSequence = 1;
        }),
      ).toEqual({ kind: "FAILED", invariant: "EVENT_SEQUENCE", tableName: "storageMetadata" });
      expect(verify((copy) => (copy.domainEvents = copy.domainEvents.slice(1)))).toMatchObject({ kind: "FAILED", invariant: "RECEIPT_REFERENCE" });
      expect(verify((copy) => (copy.storageMetadata = copy.storageMetadata.filter((row) => (row as { key: string }).key !== "DATABASE_IDENTITY")))).toMatchObject({
        kind: "FAILED",
        invariant: "METADATA",
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "keeps the runtime closed when the stored dataset fails verification and writes nothing",
    async () => {
      const name = await populatedName();
      await corrupt(name, async (database) => {
        const row = (await database.table("recordRevisions").toArray())[0] as object;
        await database.table("recordRevisions").put({ ...row, unexpected: "x" } as never);
      });
      const before = await openRaw(name).then(async (database) => {
        const tables = await readDatasetTables(database);
        database.close();
        return tables;
      });
      const error = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JagaOnStorageLockedError);
      expect((error as JagaOnStorageLockedError).lock).toMatchObject({
        kind: "INTEGRITY_LOCKED",
        failure: { errorCode: "STORAGE_INTEGRITY_FAILED", tableName: "recordRevisions", governedReasonCodes: ["ROW_SCHEMA"], userMessageKey: "packet10.integrity.integrityBody" },
      });
      const after = await openRaw(name).then(async (database) => {
        const tables = await readDatasetTables(database);
        database.close();
        return tables;
      });
      expect(after).toEqual(before);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe("runtime integrity gate", () => {
  it("locks on an integrity failure, rejects every later operation and notifies listeners", async () => {
    const gate = createIntegrityGate(() => PACKET10_NOW);
    const seen: string[] = [];
    gate.subscribe((lock) => seen.push(lock.kind));
    let writes = 0;
    const port = gate.guard({
      nested: { async read() {
        throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordHeads", "READ");
      } },
      async write() {
        writes += 1;
        return "ok";
      },
    });
    expect(await port.write()).toBe("ok");
    await expect(port.nested.read()).rejects.toBeInstanceOf(IntegrityLockedError);
    expect(gate.current()).toMatchObject({ kind: "INTEGRITY_LOCKED", failure: { tableName: "recordHeads" } });
    await expect(port.write()).rejects.toBeInstanceOf(IntegrityLockedError);
    await expect(gate.run(async () => "engine")).rejects.toBeInstanceOf(IntegrityLockedError);
    expect(writes).toBe(1);
    expect(seen).toEqual(["INTEGRITY_LOCKED"]);
  });

  it("does not lock on ordinary non-integrity failures", async () => {
    const gate = createIntegrityGate(() => PACKET10_NOW);
    await expect(gate.run(async () => {
      throw new Error("validation");
    })).rejects.toThrow("validation");
    expect(gate.current()).toBeNull();
  });
});
