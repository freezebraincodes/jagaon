import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { aiInvocationAuditRowSchema } from "@/domain/ai";
import { acceptedCareAuditRowFixture, deterministicAuditRowFixture, FIXTURE_REQUEST_ID, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { createAiInvocationAuditRepository } from "./ai-audit-persistence";
import { createAiTaskService } from "./ai-task-service";

/** Packet 11A Task 5: the AI invocation audit repository over the existing Packet 10 table. */

installFakeIndexedDb();
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function database() {
  const name = `packet11a-audit-${crypto.randomUUID()}`;
  names.push(name);
  (await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
  return openRaw(name);
}

describe("AI invocation audit repository", () => {
  it("validates before one write and reads back losslessly", async () => {
    const db = await database();
    const repository = createAiInvocationAuditRepository(db);
    const row = aiInvocationAuditRowSchema.parse(acceptedCareAuditRowFixture());
    await repository.append(row);
    expect(await repository.get(row.requestId)).toEqual(row);
    expect(await repository.list()).toEqual([row]);
    expect(await db.table("aiInvocationAudits").toArray()).toEqual([row]);
    db.close();
  });

  it("rejects a malformed row, a payload field or a whole request before any write", async () => {
    const db = await database();
    const repository = createAiInvocationAuditRepository(db);
    for (const value of [{ ...deterministicAuditRowFixture(), outcomeCode: "OK" }, { ...acceptedCareAuditRowFixture(), providerPayload: {} }, requestFixture("EXPLAIN_PATTERN")]) {
      await expect(repository.append(value as never)).rejects.toBeInstanceOf(StorageRowValidationError);
    }
    expect(await db.table("aiInvocationAudits").count()).toBe(0);
    db.close();
  });

  it("never overwrites an existing audit: a request id is written once", async () => {
    const db = await database();
    const repository = createAiInvocationAuditRepository(db);
    const row = aiInvocationAuditRowSchema.parse(deterministicAuditRowFixture());
    await repository.append(row);
    await expect(repository.append({ ...row, outcomeCode: "PROFILE_NOT_PERMITTED" })).rejects.toThrow();
    expect(await repository.get(row.requestId)).toEqual(row);
    db.close();
  });

  it("fails closed when a stored row is malformed", async () => {
    const db = await database();
    await db.table("aiInvocationAudits").add({ ...deterministicAuditRowFixture(), renderedText: "6.2 mmol/L" });
    const repository = createAiInvocationAuditRepository(db);
    await expect(repository.list()).rejects.toMatchObject({ code: "STORAGE_INTEGRITY_FAILED", table: "aiInvocationAudits" });
    db.close();
  });

  it("is the audit port of the deterministic-only service: one minimal row per execution, offline", async () => {
    const db = await database();
    const repository = createAiInvocationAuditRepository(db);
    const service = createAiTaskService({ releaseProfile: "HACKATHON_DEMO", audit: repository, now: () => PACKET10_NOW, monotonicMs: () => 0 });
    const result = await service.execute(requestFixture("DRAFT_CARE_PREPARATION_SUMMARY"));
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TASK_DISABLED", presentation: { kind: "STRUCTURED_PREVIEW" } } });
    const rows = await repository.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: FIXTURE_REQUEST_ID, outcomeCode: "TASK_DISABLED", attempts: { count: 0 }, sourceRevisions: [], downstream: null });
    expect(JSON.stringify(rows)).not.toMatch(/6\.2|pen in my bag|mmol/);
    db.close();
  });
});
