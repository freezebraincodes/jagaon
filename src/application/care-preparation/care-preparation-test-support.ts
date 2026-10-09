import Dexie from "dexie";
import type { Instant, RecordId } from "@/domain/shared";
import { careSummaryExportProjection, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { carePreparationRevisionRowCodec, careSummarySnapshotRevisionCodec } from "./care-preparation-persistence";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { createCarePreparationService } from "./care-preparation-service";
import { createCarePreparationQuery } from "./care-preparation-query";
import { createCareSummaryInvalidation } from "./care-summary-invalidation";
import type { CareSummarySelectionInput } from "./care-preparation-contracts";
import type { CareSummaryDraft } from "./deterministic-care-summary-renderer";
import { slotToken, type AiInvocationAuditRow, type ShellFieldPath, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import type { AiInvocationAuditPort, AiShellProviderPort, ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { planSlots } from "@/application/ai/language/slot-planner";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";
import { buildCareSummaryAiRequest } from "./ai-care-summary-request";

/** Shared fake-IndexedDB harness for Packet 9C application tests (test-only module). */

export const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const uuid = () => crypto.randomUUID() as never;
export const testIds = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
export const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });

const opened: JagaOnDatabase[] = [];

export async function closeCarePreparationHarnesses() {
  for (const database of opened.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
}

export async function createCarePreparationHarness() {
  const database = createJagaOnDatabase(`packet9c-${crypto.randomUUID()}`);
  opened.push(database);
  await database.open();
  const now = () => NOW;
  const carePlan = createCarePlanCommandService(database, { now, ids: testIds });
  const journal = createJournalCommandService(database, { now, ids: testIds });
  const organisation = createCareOrganisationService(database, { now, ids: testIds, carePlan });
  const visit = createCareOrganisationQuery(database, { now });
  const service = createCarePreparationService(database, { now, ids: testIds });
  const query = createCarePreparationQuery(database);
  const invalidation = createCareSummaryInvalidation(database, { now, newCommandId: uuid, leaseToken: () => crypto.randomUUID(), instanceId: "test", service });
  await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids: testIds });

  async function selection(overrides: Partial<CareSummarySelectionInput> = {}): Promise<CareSummarySelectionInput> {
    const view = await visit.loadVisitPreparation();
    if (view.status !== "READY" || !view.appointment) throw new Error("visit");
    return {
      locale: "en-SG",
      period: view.period,
      appointment: { recordType: "APPOINTMENT", recordId: view.appointment.recordId, revisionId: view.appointment.revisionId },
      groups: view.factGroups.filter((group) => group.sources.length > 0).map((group) => ({ key: group.key, sources: group.sources })),
      questions: view.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
      notSelected: [],
      ...overrides,
    };
  }

  return { database, carePlan, journal, organisation, visit, service, query, invalidation, selection };
}

/**
 * Packet 11C Task B1a (D3), test-only: what the Packet 9C code path (`care-summary-*.9c.1`) stored. A 9c.1 snapshot has no
 * care-draft notice section, carries the 9c.1 versions and, in zh-SG, the 9c.1 selected-records wording (你).
 * `care-summary-legacy-artifact.test.ts` proves that `asLegacy9c1Payload` of a current rendering equals the 9c.1 code path's own
 * captured output for the same draft, so it can stand in for a snapshot made before this change.
 */
export const LEGACY_9C1 = Object.freeze({
  templateVersion: "care-summary-template.9c.1",
  rendererVersion: "care-summary-renderer.9c.1",
  localePackVersion: "care-summary-locale.9c.1",
  zhSelectedOnly: "此摘要仅包含你所选择的记录和问题。",
});

export async function asLegacy9c1Payload(payload: CareSummarySnapshotPayload): Promise<CareSummarySnapshotPayload> {
  const sections = payload.sections
    .filter((section) => section.sectionId !== "CARE_DRAFT_NOTICES")
    .map((section) => ({
      ...section,
      blocks: section.blocks.map((block) =>
        payload.locale === "zh-SG" && block.kind === "SUMMARY_LIMITATION" && block.limitationCode === "SELECTED_RECORDS_ONLY" ? { ...block, renderedText: LEGACY_9C1.zhSelectedOnly } : block,
      ),
    })) as CareSummarySnapshotPayload["sections"];
  const contentHash = await hashCanonicalJson(
    careSummaryExportProjection({ ...payload, sections, rendererVersion: LEGACY_9C1.rendererVersion, localePackVersion: LEGACY_9C1.localePackVersion }),
  );
  const patientApproval = payload.patientApproval.state === "APPROVED" ? { ...payload.patientApproval, approvedContentHash: contentHash } : payload.patientApproval;
  return {
    ...payload,
    sections,
    composition: { ...payload.composition, templateVersion: LEGACY_9C1.templateVersion },
    rendering: { rendererVersion: LEGACY_9C1.rendererVersion, localePackVersion: LEGACY_9C1.localePackVersion, contentHash },
    patientApproval,
  };
}

/**
 * Packet 11C Task B1b, test-only: synthetic care-summary drafts (invented values, demo questions, no real person or record) for the
 * AI-assisted replacement tests. ORDINARY, MISSING_DATA and HIDDEN_LIMITATION have the shapes of the evaluated care fixture classes of
 * the same names (packet11-fixtures); RICH adds an insulin record, a meal without items and a walk with a duration.
 */
export type SyntheticCareDraftShape = "ORDINARY" | "MISSING_DATA" | "HIDDEN_LIMITATION" | "RICH";

const syntheticId = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const syntheticRef = (recordType: string, n: number) => ({ recordType, recordId: syntheticId("0000b1b0", n), revisionId: syntheticId("0000b1b1", n) }) as never;

export function syntheticCareDraft(shape: SyntheticCareDraftShape, locale: "en-SG" | "zh-SG"): CareSummaryDraft {
  const question = (n: number, en: string, zh: string) => ({ ref: syntheticRef("CARE_QUESTION", 100 + n), text: locale === "en-SG" ? `${en} (demo)` : `${zh}(演示)`, language: locale });
  const glucose = (n: number, value: string, at: string) => ({ kind: "GLUCOSE" as const, ref: syntheticRef("GLUCOSE_READING", n), occurrence: exact(at), value });
  const appointment = { ref: syntheticRef("APPOINTMENT", 50), label: locale === "en-SG" ? "Polyclinic follow-up" : "综合诊疗所复诊", scheduledAt: exact("2026-10-12T01:30:00.000Z") };
  const base = { locale, asOf: NOW, period: { startAt: "2026-09-04T16:00:00.000Z" as Instant, endAtExclusive: "2026-10-04T16:00:00.000Z" as Instant, startDate: "2026-09-05", endDate: "2026-10-04" }, excluded: [] };
  const meal = (n: number, items: string[], at: string) => ({ kind: "INTAKE" as const, ref: syntheticRef("INTAKE_EVENT", n), occurrence: exact(at), intakeKind: "MEAL", items });
  switch (shape) {
    case "ORDINARY":
      return { ...base, appointment: null, groups: [{ key: "GLUCOSE", facts: [glucose(1, "6.2", "2026-10-03T13:00:00.000Z")] }], questions: [question(1, "Can I keep the pen in my bag?", "我可以把笔放在包里吗？")] };
    case "MISSING_DATA":
      return { ...base, appointment: null, groups: [], questions: [question(1, "What should I bring to the visit?", "复诊时我应该带什么？")] };
    case "HIDDEN_LIMITATION":
      return {
        ...base,
        appointment,
        groups: [
          { key: "GLUCOSE", facts: [glucose(1, "6.1", "2026-10-01T00:30:00.000Z"), glucose(2, "6.9", "2026-10-02T00:30:00.000Z"), glucose(3, "7.2", "2026-10-03T00:30:00.000Z")] },
          { key: "MEALS", facts: [meal(10, locale === "en-SG" ? ["chapati", "kopi-o"] : ["印度煎饼", "黑咖啡"], "2026-10-02T04:00:00.000Z")] },
        ],
        questions: [question(1, "Can I travel with my meter?", "我可以带血糖仪旅行吗？"), question(2, "Where do I park?", "我在哪里停车？")],
      };
    case "RICH":
      return {
        ...base,
        appointment,
        groups: [
          { key: "GLUCOSE", facts: [glucose(1, "6.1", "2026-10-01T00:30:00.000Z"), glucose(2, "7.2", "2026-10-03T13:00:00.000Z")] },
          {
            key: "INSULIN",
            facts: [{ kind: "MEDICATION_EVENT", ref: syntheticRef("MEDICATION_EVENT", 20), occurrence: exact("2026-10-02T12:00:00.000Z"), state: "TAKEN", intendedAt: null, amount: { value: "10", unit: "UNIT" }, medication: { ref: syntheticRef("MEDICATION", 21), name: "Demo pen" } }],
          },
          { key: "MEALS", facts: [meal(10, locale === "en-SG" ? ["chapati"] : ["印度煎饼"], "2026-10-02T04:00:00.000Z"), meal(11, [], "2026-10-03T04:00:00.000Z")] },
          { key: "WALKS", facts: [{ kind: "ACTIVITY", ref: syntheticRef("ACTIVITY_EVENT", 30), occurrence: exact("2026-10-03T10:00:00.000Z"), label: locale === "en-SG" ? "Evening walk" : "傍晚散步", minutes: 30 }] },
        ],
        questions: [question(1, "Can I keep the pen in my bag?", "我可以把笔放在包里吗？")],
      };
  }
}

/** Packet 11C Task B1b, test-only: the AI invocation of the fake-provider tests and an activated test manifest (never shipped). */
export const AI_AUDIT_REF = "44444444-4444-4444-8444-444444444444";
export const AI_VALIDATED_AT = "2026-10-04T02:05:00.000Z" as Instant;
export const ENABLED_CARE_MANIFEST = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } } as typeof AI_ACTIVATION_MANIFEST;

/** Fake model wording for every care field: a neutral intro and a short framed bullet around the plan's tokens, in plan order. */
export function fakeModelCareShells(plan: SlotPlan): Map<ShellFieldPath, string> {
  const texts = new Map<ShellFieldPath, string>();
  for (const section of plan.sections) {
    texts.set(section.introPath, plan.locale === "en-SG" ? "Here are the details you chose to include:" : "以下是您选择加入的信息：");
    for (const path of section.bulletPaths) {
      const tokens = plan.fields.find((field) => field.path === path)!.requiredSlots.map(slotToken);
      texts.set(path, plan.locale === "en-SG" ? `You recorded ${tokens.join(", ")}.` : `您记录了${tokens.join("，")}。`);
    }
  }
  return texts;
}

/**
 * Builds the provider shell candidate (the shape the shell route returns) from field texts. Test files pass the evaluation helper
 * `shellCandidate` (packet-11-hybrid-test-support); this module itself imports no evaluation code.
 */
export type CareShellCandidateBuilder = (plan: SlotPlan, texts: ShellTexts) => unknown;

/** A fake shell provider answering every call with `answer(plan)` for the plan of the request it was built for. */
export function fakeCareShellProvider(answer: () => ProviderInvocationResult | Promise<ProviderInvocationResult>): AiShellProviderPort & { calls: number } {
  const provider = {
    calls: 0,
    providerModel: { providerKey: "test", modelSnapshot: "test-model" },
    invoke: async () => {
      provider.calls += 1;
      return answer();
    },
  };
  return provider;
}

export const completedShells = (candidate: unknown): ProviderInvocationResult => ({ kind: "COMPLETED", candidate, usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 }, responseModel: "test-model", retention: "CONFIRMED_NOT_STORED" });

/** The hybrid service, activated by the injected test manifest, answering with a fake provider: an accepted AI care composition. */
export async function acceptedAiCareComposition(current: CareSummarySnapshotPayload, options: { candidate: CareShellCandidateBuilder; requestId?: string; audit?: AiInvocationAuditPort; shells?: (plan: SlotPlan) => Map<ShellFieldPath, string> }) {
  const built = buildCareSummaryAiRequest({ current, requestId: options.requestId ?? AI_AUDIT_REF, requestedAt: NOW });
  if (built.kind !== "READY") throw new Error(built.reason);
  const planned = planSlots(built.request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
  if (planned.kind !== "PLANNED") throw new Error(planned.reason);
  const rows: AiInvocationAuditRow[] = [];
  const service = createAiHybridTaskService({
    releaseProfile: "HACKATHON_DEMO",
    audit: options.audit ?? { append: async (row) => void rows.push(row) },
    now: () => AI_VALIDATED_AT,
    monotonicMs: () => 0,
    manifest: ENABLED_CARE_MANIFEST,
    provider: fakeCareShellProvider(() => completedShells(options.candidate(planned.plan, (options.shells ?? fakeModelCareShells)(planned.plan) as ShellTexts))),
    // Packet 11C Addendum C (C1): test-only QUALIFIED records (the shipped records are all PENDING).
    requestClassGate: qualifiedTestRequestClassGate(),
  });
  const result = await service.execute(built.request);
  if (result.kind !== "COMPOSED" || result.source !== "AI") throw new Error(`expected an AI composition, got ${JSON.stringify(result.kind === "COMPOSED" ? result.reason : result.kind)}`);
  return { composition: result.composition, rows, request: built.request, auditRef: result.auditRef };
}

/** Rewrites every stored revision of one snapshot in place as the 9c.1 code path would have stored it (test fixture only). */
export async function rewriteAsLegacy9c1Snapshot(database: JagaOnDatabase, recordId: RecordId): Promise<CareSummarySnapshotPayload> {
  const rows = await database.table("recordRevisions").where("recordId").equals(recordId).toArray();
  let latest: { revisionNumber: number; payload: CareSummarySnapshotPayload } | null = null;
  for (const raw of rows) {
    const { revision } = carePreparationRevisionRowCodec.validateAfterRead(raw);
    if (revision.recordType !== "CARE_SUMMARY_SNAPSHOT") throw new Error("legacy fixture: not a snapshot");
    const payload = await asLegacy9c1Payload(revision.payload);
    await database.table("recordRevisions").put(careSummarySnapshotRevisionCodec.create({ ...revision, payload }));
    if (!latest || revision.revisionNumber > latest.revisionNumber) latest = { revisionNumber: revision.revisionNumber, payload };
  }
  if (!latest) throw new Error("legacy fixture: no snapshot");
  return latest.payload;
}
