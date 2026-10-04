import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { RecordHead, RecordId } from "@/domain/shared";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact } from "@/application/care-preparation/care-preparation-test-support";
import { careSummaryEffectsFor } from "@/application/care-preparation/care-summary-invalidation";
import { PACKET_9_SUBSCRIPTIONS } from "@/application/packet9-subscriptions";
import { careSummaryCompositionSchema, CARE_SUMMARY_MAX_PERIOD_DAYS, CARE_SUMMARY_MAX_SELECTIONS } from "@/domain/care-preparation/care-summary-snapshot";
import { HACKATHON_EXPORT_PROFILE, careSummaryExternalConfirmationSchema } from "@/domain/care-preparation/care-summary-export";
import { CARE_SUMMARY_LOCALE_PACK_VERSION, CARE_SUMMARY_RENDERER_VERSION } from "@/application/care-preparation/care-summary-locale-pack";
import { CARE_SUMMARY_SOURCE_EVALUATOR, CARE_PREPARATION_EVENT_TARGETS } from "@/application/care-preparation/care-preparation-persistence";
import { PACKET_9C_EVENT_OWNERSHIP } from "@/application/contracts/command-event-names";
import { REVERSE_DEPENDENCY_EVALUATORS } from "@/storage/reverse-dependency-row";
import { ALL_SCREENS, PACKET_9C_CHILD_SCREENS, TOP_LEVEL_SCREENS } from "./screen-manifest";

/**
 * Packet 9C release manifest: deterministic-only composition, print-only
 * export, dormant external confirmation, exact reverse dependencies, no
 * location in summaries and no Packet 10, 11 or 7B reach.
 */

const ROOT = process.cwd();
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

const PACKET_9C_SOURCES = [
  ...files("src/domain/care-preparation"),
  ...files("src/application/care-preparation").filter((file) => !file.endsWith("care-preparation-test-support.ts")),
  ...files("src/components/jagaon/care-preparation"),
  "src/components/jagaon/screens/CareSummaryPreviewScreen.tsx",
];

describe("Packet 9C manifest", () => {
  it("composes deterministically only, with pinned renderer and locale-pack versions", () => {
    expect(careSummaryCompositionSchema.safeParse({ method: "AI_ASSISTED", templateVersion: "x" }).success).toBe(false);
    expect([CARE_SUMMARY_RENDERER_VERSION, CARE_SUMMARY_LOCALE_PACK_VERSION]).toEqual(["care-summary-renderer.9c.1", "care-summary-locale.9c.1"]);
    expect([CARE_SUMMARY_MAX_SELECTIONS, CARE_SUMMARY_MAX_PERIOD_DAYS]).toEqual([32, 180]);
  });

  it("exports only a printable document through the print dialog, with no download, share, upload or email path", () => {
    expect(HACKATHON_EXPORT_PROFILE).toEqual({ method: "PRINT_DIALOG", artifactFormat: "PRINTABLE_DOCUMENT" });
    for (const file of PACKET_9C_SOURCES) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toMatch(/createObjectURL|new Blob\(|navigator\.share|mailto:|\bfetch\(|XMLHttpRequest|download=|jspdf|pdf-lib|sendBeacon|WebSocket/);
    }
  });

  it("keeps external confirmation NONE on every path and has no delivery or review event", () => {
    expect(careSummaryExternalConfirmationSchema.safeParse({ state: "NONE" }).success).toBe(true);
    expect(careSummaryExternalConfirmationSchema.safeParse({ state: "DELIVERED", confirmedAt: "2026-10-04T02:00:00.000Z", authorisedIntegrationId: "x", integrationVersion: "1", externalConfirmationRef: "r" }).success).toBe(false);
    for (const file of PACKET_9C_SOURCES.filter((path) => !path.startsWith("src/domain/"))) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toMatch(/state:\s*["'](?:DELIVERED|REVIEWED)["']/);
    }
    expect(Object.keys(PACKET_9C_EVENT_OWNERSHIP).filter((name) => /DELIVERED|(?<!P)REVIEWED|CONFIRMED/.test(name))).toEqual([]);
    expect(Object.keys(CARE_PREPARATION_EVENT_TARGETS).sort()).toEqual([...Object.keys(PACKET_9C_EVENT_OWNERSHIP), "PATIENT_RECORD_DELETED"].sort());
  });

  it("registers exactly one summary-source reverse dependency", () => {
    expect(REVERSE_DEPENDENCY_EVALUATORS[CARE_SUMMARY_SOURCE_EVALUATOR.key]).toEqual({
      versions: [CARE_SUMMARY_SOURCE_EVALUATOR.version],
      owner: "CARE_PREPARATION",
      dependentRecordType: "CARE_SUMMARY_SNAPSHOT",
      roles: [CARE_SUMMARY_SOURCE_EVALUATOR.role],
    });
    expect(strip(readFileSync(join(ROOT, "src/storage/authoritative-command-transaction.ts"), "utf8"))).toMatch(/PURGED_DERIVED_RECORD_TYPES[\s\S]*"CARE_SUMMARY_SNAPSHOT"/);
  });

  it("puts no location search data into a summary and logs nothing", () => {
    for (const file of PACKET_9C_SOURCES) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toMatch(/nearby-food|onemap|geolocation|latitude|longitude|postal/i);
      expect(source, file).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
    }
  });

  it("adds one preview child route and leaves the four bottom tabs unchanged", () => {
    expect(PACKET_9C_CHILD_SCREENS).toEqual(["CARE_SUMMARY_PREVIEW"]);
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "MEDICATION_SCHEDULE", "HISTORY", "MORE"]);
  });
});

// --- Packet 9 Corrective Pass B: deletion stays with Packet 10A -----------------------------

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalKeyRange;
});
afterEach(() => closeCarePreparationHarnesses());

const SRC = join(ROOT, "src");
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => join(ROOT, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]!;
      const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!base) continue;
      const target = (extname(base) ? [base] : [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => `${base}${suffix}`)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target) pending.push(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
}

const RUNTIME_GRAPH = importGraph(["src/app/page.tsx", "src/app/api/onemap/search/route.ts"]);
const SUMMARY_SOURCE_OWNERS = ["src/application/journal/journal-command-service.ts", "src/application/journal/journal-contracts.ts", "src/application/care-plan/care-plan-command-service.ts", "src/application/care-plan/care-plan-persistence.ts"];

const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };

async function approvedSnapshot() {
  const h = await createCarePreparationHarness();
  const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  const question = await h.organisation.createCareQuestion({ questionText: { text: "Bring my meter?", language: "en-SG" } });
  if (reading.kind !== "COMMITTED" || question.kind !== "COMMITTED") throw new Error("fixture");
  const prepared = await h.service.prepare(await h.selection());
  if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
  const view = await h.query.loadSummary(prepared.recordId);
  if (view.status !== "READY") throw new Error("ready");
  const hash = view.payload.rendering.contentHash;
  const previewed = await h.service.markPreviewed({ recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: 1, contentHash: hash });
  if (previewed.kind !== "COMMITTED") throw new Error("previewed");
  const approved = await h.service.approve({ recordId: prepared.recordId, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: 2, contentHash: hash });
  if (approved.kind !== "COMMITTED") throw new Error("approved");
  const request = (approvedContentHash = hash) => h.service.requestPrintExport({ recordId: prepared.recordId, expectedRevisionId: approved.revisionId, expectedRevisionNumber: 3, approvedContentHash });
  const exportCount = async () => (await h.database.table("recordHeads").toArray()).filter((row) => row.recordType === "CARE_SUMMARY_EXPORT").length;
  return { h, reading, question, snapshotId: prepared.recordId, hash, request, exportCount };
}

describe("Packet 9 permanent-deletion boundary (Corrective Pass B)", () => {
  it("exposes no permanent source-record deletion command or UI", async () => {
    for (const file of [...SUMMARY_SOURCE_OWNERS, ...PACKET_9C_SOURCES, "src/application/journal/browser-journal-runtime.ts", "src/components/jagaon/JagaOnApp.tsx"]) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toMatch(/deletePatientRecord|DELETE_PATIENT_RECORD|deletionParticipant|DeletionParticipant|systemPurge/);
    }
    // No Packet 9 owner of a summary source plans a tombstone; care preparation never purges on its own.
    for (const file of ["src/application/journal/journal-command-service.ts", "src/application/care-plan/care-plan-command-service.ts", "src/application/care-preparation/care-preparation-service.ts"]) {
      expect(strip(readFileSync(join(ROOT, file), "utf8")), file).not.toMatch(/kind:\s*"DELETE"/);
    }
    const h = await createCarePreparationHarness();
    for (const service of [h.journal, h.carePlan, h.service, h.organisation]) {
      expect(Object.keys(service).filter((key) => /delete|purge/i.test(key))).toEqual([]);
    }
    expect(existsSync(join(ROOT, "src/application/care-preparation/care-summary-deletion-participant.ts"))).toBe(false);
    for (const file of files("src/components/jagaon").filter((path) => /care-organisation|care-preparation|PreventiveCare|CarePreparation|CareSummary/.test(path))) {
      expect(strip(readFileSync(join(ROOT, file), "utf8")), file).not.toMatch(/deletePatientRecord|permanently delete|deleteRecord/i);
    }
  });

  it("leaves deletion-plan confirmation and complete permanent deletion to Packet 10", () => {
    // Deletion planning and confirmation exist only in Packet 10A's own modules.
    const everywhere = files("src");
    const packet10 = /^src\/(application\/deletion|application\/storage|storage\/(delete-dataset|permanent-deletion-transaction)|components\/jagaon\/data)/;
    expect(everywhere.filter((file) => /deletion-plan|confirmation-token|deletion-closure|delete-all/i.test(file) && !packet10.test(file))).toEqual([]);
    for (const file of everywhere.filter((path) => !packet10.test(path))) {
      expect(strip(readFileSync(join(ROOT, file), "utf8")), file).not.toMatch(/confirmationToken|deletionPlanHash|DeletionParticipant|deletionParticipants/);
    }
    // The authoritative transaction has no owner-participation hook; Packet 9 queues no deletion purge.
    expect(PACKET_9_SUBSCRIPTIONS.filter((entry) => entry.consumer === "CARE_SUMMARY_INVALIDATION" && entry.eventName === "PATIENT_RECORD_DELETED")).toEqual([]);
  });

  it("fails export closed when a source is missing, tombstoned, changed or hash-mismatched", async () => {
    // Hash mismatch.
    const mismatch = await approvedSnapshot();
    expect(await mismatch.request("f".repeat(64))).toEqual({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" });
    expect(await mismatch.exportCount()).toBe(0);

    // Changed: a corrected source.
    const changed = await approvedSnapshot();
    await changed.h.journal.correctGlucoseTime({ recordId: changed.reading.recordId, expectedRevisionId: changed.reading.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    expect(await changed.request()).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
    expect(await changed.exportCount()).toBe(0);

    // Tombstoned: a fixture standing in for a later Packet 10A deletion (Packet 9 cannot produce it).
    const tombstoned = await approvedSnapshot();
    const head = (await tombstoned.h.database.table("recordHeads").get(tombstoned.reading.recordId)) as RecordHead;
    await tombstoned.h.database.table("recordHeads").put({ ...head, state: "DELETED", updatedAt: NOW });
    await tombstoned.h.database.table("deletionTombstones").put({ recordId: head.recordId, recordType: head.recordType, deletedAt: NOW, initiator: "PATIENT", auditEventId: crypto.randomUUID(), transactionId: crypto.randomUUID() });
    expect(await tombstoned.request()).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
    expect(await tombstoned.exportCount()).toBe(0);
    const stale = await tombstoned.h.query.loadSummary(tombstoned.snapshotId);
    expect(stale.status === "READY" && stale.sourcesCurrent).toBe(false);
    // No asynchronous purge stands in for Packet 10A's deletion transaction.
    expect(await careSummaryEffectsFor(tombstoned.h.database, tombstoned.h.service, { kind: "RECORD_DELETED", recordType: "GLUCOSE_READING", recordId: head.recordId, previousRevisionId: head.headRevisionId, resultingRevisionId: null } as never)).toEqual([]);

    // Missing: a source head that no longer exists.
    const missing = await approvedSnapshot();
    await missing.h.database.table("recordHeads").delete(missing.question.recordId as RecordId);
    expect(await missing.request()).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
    expect(await missing.exportCount()).toBe(0);
  }, 60_000);

  it("still invalidates on correction and revision through the care-summary worker", async () => {
    const corrected = await approvedSnapshot();
    await corrected.h.journal.correctGlucoseTime({ recordId: corrected.reading.recordId, expectedRevisionId: corrected.reading.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    expect((await corrected.h.invalidation.processPending()).committedCommands).toBe(1);
    const afterCorrection = await corrected.h.query.loadSummary(corrected.snapshotId);
    expect(afterCorrection.status === "READY" && [afterCorrection.snapshotStatus, afterCorrection.payload.invalidation?.reason]).toEqual(["INVALIDATED", "SOURCE_CORRECTED"]);

    const revised = await approvedSnapshot();
    await revised.h.organisation.reviseCareQuestion({ recordId: revised.question.recordId, expectedRevisionId: revised.question.revisionId, expectedRevisionNumber: 1, questionText: { text: "Bring my meter and pen?", language: "en-SG" }, state: "READY_TO_ASK" });
    expect((await revised.h.invalidation.processPending()).committedCommands).toBe(1);
    const afterRevision = await revised.h.query.loadSummary(revised.snapshotId);
    expect(afterRevision.status === "READY" && [afterRevision.snapshotStatus, afterRevision.payload.invalidation?.reason]).toEqual(["INVALIDATED", "SOURCE_SUPERSEDED"]);
  }, 60_000);

  it("has no Packet 11, 12 or 7B imports or routes; Packet 10 adds only its own data paths", () => {
    // Packet 10's encrypted portability and storage modules are the only backup/restore paths.
    const packet10 = /^src\/(backup|storage|application\/(storage|deletion|restore)|components\/jagaon\/data|i18n\/(packet10-types|messages\/packet10-))/;
    const forbidden = RUNTIME_GRAPH.filter(
      (file) =>
        !packet10.test(file) &&
        /backup|restore|import-export|data-export|packet-?1[0-2]|(^|\/)ai\/|ai-assist|routine-shift|recurring-barrier|prescribed-timing|barrier-learning/i.test(file),
    );
    expect(forbidden, forbidden.join("\n")).toEqual([]);
    expect(RUNTIME_GRAPH.filter((file) => /packet-?1[12]/i.test(file))).toEqual([]);
    expect(RUNTIME_GRAPH).toContain("src/components/jagaon/screens/CareSummaryPreviewScreen.tsx");
    expect([...ALL_SCREENS].filter((screen) => /BACKUP|RESTORE|IMPORT|DATA_EXPORT|DELETE|AI_|ASSIST|TREND|ROUTINE_SHIFT/.test(screen))).toEqual(["DATA_BACKUP"]);
  });
});
