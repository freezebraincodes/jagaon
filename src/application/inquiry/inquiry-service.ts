import { z } from "zod";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import { fingerprint } from "@/application/intelligence/metrics";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { PresentedBarrierQuestion } from "./inquiry-presentation-contracts";
import {
  enabledInquiryDefinitions,
  expectedInquiryRevisionShape,
  findInquiryDefinition,
  isEnabledDefinition,
  type EnabledInquiryDefinition,
  type InquiryLifecycle,
  type InquiryPayload,
  type InquiryPresentationKey,
  type InquiryRawAnswer,
  type InquiryResponseRevision,
  type InquiryRevision,
} from "@/domain/inquiry";
import { INQUIRY_CAPABILITY_MANIFEST, type InquiryCapabilityManifest, type SnoozeChoice } from "@/inquiry/inquiry-capability-manifest";
import {
  assessBarrierEligibility,
  buildBarrierCandidate,
  exactOccasionOf,
  type BarrierBasisView,
  type PriorBarrierInquiry,
} from "@/inquiry/medication-occasion-barrier";
import { arbitrateInquiries, type ArbiterCandidate, type BudgetState, type PresentationHistoryEntry } from "@/inquiry/inquiry-arbiter";
import { presentationExpired, revalidateForPresentation, snoozeUntil } from "@/inquiry/inquiry-lifecycle-rules";
import { buildBarrierResponseParts } from "@/inquiry/barrier-response";
import { renderBarrierContent, type BarrierTemplateCopy } from "@/inquiry/barrier-template";
import { medicationEventRevisionCodec, type MedicationEventRevision } from "@/application/journal/journal-row-codecs";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import type { MedicationRevision } from "@/domain/care-plan/care-plan-revisions";
import { INQUIRY_ELIGIBILITY_HANDLER_VERSION } from "@/application/packet8-subscriptions";
import { runOwnedWork, type OwnedEffect, type OwnedWorkReport } from "@/application/owned-work-runner";
import { OwnerPlanError } from "@/application/owner-plan-support";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import type { JagaOnDatabase } from "@/storage/database";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import {
  buildInquiryCommitPlan,
  createInquiryCommandStore,
  inquiryOwnedRevisionRowCodec,
  type InquiryAuditReason,
  type InquiryChange,
} from "./inquiry-persistence";

/**
 * Packet 8 Inquiry application service (deterministic-engine Sections 13–15
 * and 18; event-contracts Sections 7.2 and 10).
 *
 * The only active definition asks about one exact medication occasion that
 * the patient explicitly recorded as skipped or not sure. Nothing here reads
 * an absent record, a reminder interaction or free text as a reason to ask.
 * Every response records the capability-bound `NOT_APPLICABLE` Safety
 * disposition; no Safety evaluator, handler, route, policy or record exists
 * on any path.
 */

export const INQUIRY_DEPENDENCY_EVALUATOR = Object.freeze({ key: "inquiry.medication-occasion-barrier", version: "8.1", role: "INQUIRY_BASIS" });

const SYSTEM_RULE: ProvenanceCore = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const PATIENT_INQUIRY: ProvenanceCore = { sourceKind: "PATIENT_RESPONSE", captureMethod: "INQUIRY", initiator: "PATIENT", assistance: "NONE" };

const OPEN_STATES = Object.freeze(["CANDIDATE", "ELIGIBLE", "QUEUED", "PRESENTED", "SNOOZED"] as const);
const ANSWER_STATES = Object.freeze(["ANSWERED", "NOT_SURE", "DECLINED"] as const);

export type BarrierPresentationCopy = {
  template: BarrierTemplateCopy;
  statusLabel: (state: "MISSED" | "UNSURE") => string;
  occasionDate: (localDate: string) => string;
};

export type InquiryServiceDependencies = {
  now(): Instant;
  ids: {
    commandId(): CommandId;
    correlationId(): CorrelationId;
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    domainEventId(): DomainEventId;
    presentationKey(): string;
    leaseToken(): string;
  };
  instanceId: string;
  copy(locale: SupportedLocale): BarrierPresentationCopy;
  manifest?: InquiryCapabilityManifest;
};

export type { PresentedBarrierQuestion };

export type OfferResult =
  | { kind: "PRESENTED"; question: PresentedBarrierQuestion }
  | { kind: "NONE"; reason: "NO_ELIGIBLE_QUESTION" | "NOT_SELECTED" | "DEFERRED" | "SNOOZED" | "STORAGE_UNAVAILABLE" };

export type InquiryActionResult =
  | { kind: "COMMITTED"; responseRecordId?: RecordId }
  | { kind: "REJECTED"; code: "INQUIRY_ALREADY_RESOLVED" | "PRESENTATION_NOT_ANSWERABLE" | "ANSWER_NOT_PERMITTED" | "HEAD_CONFLICT" }
  | { kind: "FAILED"; code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "TIMEZONE_RECONCILIATION_REQUIRED" };

type Chain = { head: RecordHead; current: InquiryRevision; revisions: InquiryRevision[] };

export type InquiryService = ReturnType<typeof createInquiryService>;

export function createInquiryService(database: JagaOnDatabase, dependencies: InquiryServiceDependencies) {
  const store = createInquiryCommandStore(database);
  const manifest = dependencies.manifest ?? INQUIRY_CAPABILITY_MANIFEST;
  const { ids } = dependencies;
  const barrier = (): EnabledInquiryDefinition => enabledInquiryDefinitions()[0]!;

  // --- reads -----------------------------------------------------------------------------

  async function headOf(recordId: string): Promise<RecordHead | null> {
    return ((await database.table("recordHeads").get(recordId)) as RecordHead | undefined) ?? null;
  }

  async function readChain(recordId: RecordId): Promise<Chain | null> {
    const head = await headOf(recordId);
    if (!head || head.state !== "ACTIVE" || head.recordType !== "INQUIRY") return null;
    const rows = await database.table("recordRevisions").where("recordId").equals(recordId).toArray();
    const revisions = rows
      .map((row) => inquiryOwnedRevisionRowCodec.validateAfterRead(row).revision as InquiryRevision)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    const current = revisions.find((revision) => revision.revisionId === head.headRevisionId);
    if (!current) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return { head, current, revisions };
  }

  async function activeChains(): Promise<Chain[]> {
    const heads = (await database.table("recordHeads").where("recordType").equals("INQUIRY").toArray()) as RecordHead[];
    const chains: Chain[] = [];
    for (const head of heads.filter((entry) => entry.state === "ACTIVE").sort((a, b) => (a.recordId < b.recordId ? -1 : 1))) {
      const chain = await readChain(head.recordId);
      if (chain) chains.push(chain);
    }
    return chains;
  }

  async function readMedicationEvent(revisionId: string): Promise<MedicationEventRevision | null> {
    const raw = await database.table("recordRevisions").get(revisionId);
    if (raw === undefined) return null;
    return medicationEventRevisionCodec.validateAfterRead(raw).revision;
  }

  async function basisFor(ref: TypedRevisionRef<"MEDICATION_EVENT">): Promise<BarrierBasisView | null> {
    const revision = await readMedicationEvent(ref.revisionId);
    if (!revision) return null;
    const head = await headOf(ref.recordId);
    return { ref, isCurrentHead: head?.state === "ACTIVE" && head.headRevisionId === ref.revisionId, payload: revision.payload };
  }

  function basisRefOf(payload: InquiryPayload): TypedRevisionRef<"MEDICATION_EVENT"> | null {
    if (payload.basis.purpose !== "RECORD_CLARIFICATION") return null;
    const ref = payload.basis.records[0];
    return ref?.recordType === "MEDICATION_EVENT" ? (ref as TypedRevisionRef<"MEDICATION_EVENT">) : null;
  }

  async function inquiriesForSource(sourceRevisionIds: readonly string[]): Promise<RecordId[]> {
    if (sourceRevisionIds.length === 0) return [];
    const edges = (await database.table("reverseDependencies").where("sourceRevisionId").anyOf([...sourceRevisionIds]).toArray()) as StoredReverseDependency[];
    return [...new Set(edges.filter((edge) => edge.owner === "INQUIRY" && edge.dependentRecordType === "INQUIRY").map((edge) => edge.dependentRecordId))].sort();
  }

  function stateSince(chain: Chain): Instant {
    return chain.current.revisionCreatedAt;
  }

  function priorsFor(chains: readonly Chain[], deduplicationKey: string, excludeRecordId: string | null): PriorBarrierInquiry[] {
    return chains
      .filter((chain) => chain.current.payload.deduplicationKey === deduplicationKey && chain.current.recordId !== excludeRecordId)
      .map((chain) => ({
        recordId: chain.current.recordId,
        state: chain.current.payload.lifecycle.state,
        basisRevisionId: basisRefOf(chain.current.payload)?.revisionId ?? "",
        stateSince: stateSince(chain),
      }));
  }

  function presentationHistory(chains: readonly Chain[]): PresentationHistoryEntry[] {
    return chains.flatMap((chain) =>
      chain.revisions.flatMap((revision) =>
        revision.payload.lifecycle.state === "PRESENTED"
          ? [{ inquiryRecordId: chain.current.recordId, presentedAt: revision.payload.lifecycle.presentation.presentedAt, presentationClass: revision.payload.lifecycle.presentation.presentationClass }]
          : [],
      ),
    );
  }

  function budgetExcluding(chains: readonly Chain[], recordId: string, now: Instant): BudgetState {
    return {
      presentedNow: chains
        .filter(
          (chain) =>
            chain.current.recordId !== recordId &&
            chain.current.payload.lifecycle.state === "PRESENTED" &&
            !presentationExpired(chain.current.payload.lifecycle.presentation, manifest, now),
        )
        .map((chain) => chain.current.recordId),
      history: presentationHistory(chains),
    };
  }

  // --- writes ----------------------------------------------------------------------------

  function nextInquiryRevision(previous: InquiryRevision, lifecycle: InquiryLifecycle, now: Instant, transactionId: TransactionId): InquiryRevision {
    const shape = expectedInquiryRevisionShape(lifecycle.state);
    return {
      ...previous,
      revisionId: ids.revisionId(),
      revisionNumber: previous.revisionNumber + 1,
      previousRevisionId: previous.revisionId,
      action: shape.action,
      revisionCreatedAt: now,
      provenance: shape.initiator === "PATIENT" ? PATIENT_INQUIRY : SYSTEM_RULE,
      auditEventId: ids.auditEventId(),
      transactionId,
      payload: { ...previous.payload, lifecycle },
    } as InquiryRevision;
  }

  function transitionChange(chain: Chain, next: InquiryRevision, auditReason: InquiryAuditReason): InquiryChange {
    const used = new Set(
      chain.revisions.flatMap((revision) => (revision.payload.lifecycle.state === "PRESENTED" ? [revision.payload.lifecycle.presentation.presentationKey as string] : [])),
    );
    return {
      kind: "REVISION",
      revision: next,
      expectedHead: chain.head,
      transitionFrom: { previous: chain.current, usedPresentationKeys: used },
      eventId: ids.domainEventId(),
      eventName: "INQUIRY_TRANSITIONED",
      auditReason,
    };
  }

  type CommitOutcome = { kind: "COMMITTED"; resultingRevisions: { recordId: RecordId; revisionId: RevisionId }[] } | { kind: "REJECTED" } | { kind: "FAILED"; code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" };

  async function commit(input: {
    commandName: string;
    hashMaterial: unknown;
    commandId?: CommandId;
    transactionId: TransactionId;
    now: Instant;
    changes: InquiryChange[];
    edges?: StoredReverseDependency[];
  }): Promise<CommitOutcome> {
    try {
      const plan = buildInquiryCommitPlan({
        commandId: input.commandId ?? ids.commandId(),
        commandHash: fingerprint({ commandName: input.commandName, content: input.hashMaterial }),
        correlationId: ids.correlationId(),
        transactionId: input.transactionId,
        completedAt: input.now,
        changes: input.changes,
        reverseDependencies: input.edges ?? [],
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") return { kind: "COMMITTED", resultingRevisions: receipt.resultingRevisions };
      if (receipt.outcome === "REJECTED") return { kind: "REJECTED" };
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    } catch (error) {
      if (error instanceof OwnerPlanError || error instanceof z.ZodError || error instanceof StorageRowValidationError) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      if (error instanceof CommandTransactionError && error.code === "COMMAND_REPLAY_MISMATCH") return { kind: "FAILED", code: "VALIDATION_FAILED" };
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  async function transition(chain: Chain, lifecycle: InquiryLifecycle, auditReason: InquiryAuditReason, commandId?: CommandId): Promise<CommitOutcome> {
    const now = dependencies.now();
    const transactionId = ids.transactionId();
    const next = nextInquiryRevision(chain.current, lifecycle, now, transactionId);
    return commit({
      commandName: "TRANSITION_INQUIRY",
      hashMaterial: { inquiry: chain.current.recordId, from: chain.current.revisionId, lifecycle },
      commandId,
      transactionId,
      now,
      changes: [transitionChange(chain, next, auditReason)],
    });
  }

  async function createCandidate(basis: BarrierBasisView, commandId: CommandId): Promise<RecordId | null> {
    const candidate = buildBarrierCandidate(barrier(), manifest, basis);
    if (!candidate) return null;
    const now = dependencies.now();
    const transactionId = ids.transactionId();
    const recordId = ids.recordId();
    const revision = {
      schemaVersion: 1,
      recordType: "INQUIRY",
      recordId,
      revisionId: ids.revisionId(),
      revisionNumber: 1,
      previousRevisionId: null,
      action: "CREATE",
      recordedAt: now,
      revisionCreatedAt: now,
      temporal: { kind: "ATEMPORAL" },
      provenance: SYSTEM_RULE,
      auditEventId: ids.auditEventId(),
      transactionId,
      payload: candidate.payload,
    } as InquiryRevision;
    const edge: StoredReverseDependency = {
      sourceRevisionId: basis.ref.revisionId,
      dependentRecordType: "INQUIRY",
      dependentRecordId: recordId,
      dependentRevisionId: revision.revisionId,
      dependencyRole: INQUIRY_DEPENDENCY_EVALUATOR.role,
      owner: "INQUIRY",
      evaluatorKey: INQUIRY_DEPENDENCY_EVALUATOR.key,
      evaluatorVersion: INQUIRY_DEPENDENCY_EVALUATOR.version,
      createdAt: now,
    };
    const outcome = await commit({
      commandName: "CREATE_INQUIRY_CANDIDATE",
      hashMaterial: { definition: candidate.payload.definition, basis: basis.ref },
      commandId,
      transactionId,
      now,
      changes: [{ kind: "REVISION", revision, expectedHead: null, eventId: ids.domainEventId(), eventName: "INQUIRY_CREATED", auditReason: "CANDIDATE_CREATED" }],
      edges: [edge],
    });
    if (outcome.kind !== "COMMITTED") throw new Error("CANDIDATE_NOT_COMMITTED");
    return outcome.resultingRevisions[0]!.recordId;
  }

  /** Fresh eligibility for a chain: ELIGIBLE when every dimension passes, otherwise withdrawn or expired. */
  async function assess(chain: Chain, chains: readonly Chain[]): Promise<CommitOutcome | null> {
    const now = dependencies.now();
    const definition = findInquiryDefinition(chain.current.payload.definition.definitionKey, chain.current.payload.definition.definitionVersion);
    const ref = basisRefOf(chain.current.payload);
    if (!isEnabledDefinition(definition) || !ref) {
      return transition(chain, { state: "EXPIRED", expiredAt: now, reason: "DEFINITION_WITHDRAWN" }, "EXPIRED");
    }
    const basis = await basisFor(ref);
    if (!basis) return transition(chain, { state: "WITHDRAWN", withdrawnAt: now, reason: "EVIDENCE_CHANGED" }, "WITHDRAWN");
    const assessment = assessBarrierEligibility({
      definition,
      manifest,
      basis,
      priors: priorsFor(chains, chain.current.payload.deduplicationKey, chain.current.recordId),
      now,
    });
    if (assessment.outcome === "ELIGIBLE") return transition(chain, { state: "ELIGIBLE", assessment }, "ELIGIBILITY_ASSESSED");
    const failed = assessment.dimensions.find((entry) => entry.outcome !== "PASS")!;
    const reason =
      failed.dimension === "CURRENT_ANSWER_ABSENT"
        ? "CURRENT_ANSWER_AVAILABLE"
        : failed.dimension === "PREVIOUS_DISPOSITION"
          ? "PATIENT_PREFERENCE"
          : failed.dimension === "IDENTIFIABLE_BASIS"
            ? "EVIDENCE_CHANGED"
            : "ELIGIBILITY_CHANGED";
    if (failed.dimension === "ANSWERABLE" || failed.dimension === "USEFUL_NOW") {
      return transition(chain, { state: "EXPIRED", expiredAt: now, reason: "ANSWERABILITY_ENDED" }, "EXPIRED");
    }
    return transition(chain, { state: "WITHDRAWN", withdrawnAt: now, reason }, "WITHDRAWN");
  }

  async function deleteChain(chain: Chain, reason: "PATIENT_DELETED" | "SOURCE_DELETED", initiator: "PATIENT" | "JAGAON_SYSTEM", commandId?: CommandId): Promise<CommitOutcome> {
    const now = dependencies.now();
    const transactionId = ids.transactionId();
    const changes: InquiryChange[] = [];
    const lifecycle = chain.current.payload.lifecycle;
    if (lifecycle.state === "ANSWERED" || lifecycle.state === "NOT_SURE" || lifecycle.state === "DECLINED") {
      // Never keep an identifiable answer without the exact question it answered.
      const responseHead = await headOf(lifecycle.response.recordId);
      if (responseHead?.state === "ACTIVE") {
        changes.push({ kind: "DELETE", head: responseHead, deletedAt: now, initiator, auditEventId: ids.auditEventId(), eventId: ids.domainEventId(), auditReason: reason });
      }
    }
    changes.push({ kind: "DELETE", head: chain.head, deletedAt: now, initiator, auditEventId: ids.auditEventId(), eventId: ids.domainEventId(), auditReason: reason });
    return commit({ commandName: "DELETE_INQUIRY", hashMaterial: { inquiry: chain.current.recordId, head: chain.head.headRevisionId, reason }, commandId, transactionId, now, changes });
  }

  // --- queued Inquiry eligibility work ---------------------------------------------------------

  async function eligibilityEffects(eventId: string): Promise<OwnedEffect[]> {
    const event = committedDomainEventRowCodec.validateAfterRead(await database.table("domainEvents").get(eventId));
    const change = event.change;
    if (change.recordType !== "MEDICATION_EVENT") return [];
    const effects: OwnedEffect[] = [];

    if (change.kind === "RECORD_DELETED") {
      // Deleting a source removes every inquiry that could disclose it.
      const history = (await database.table("recordRevisions").where("recordId").equals(change.recordId).toArray()) as Array<{ revisionId: string }>;
      const sources = [...new Set([change.previousRevisionId, ...history.map((row) => row.revisionId)])];
      for (const recordId of await inquiriesForSource(sources)) {
        effects.push({
          effectKey: `delete:${recordId}`,
          async run(commandId) {
            const chain = await readChain(recordId);
            if (!chain) return false;
            const outcome = await deleteChain(chain, "SOURCE_DELETED", "JAGAON_SYSTEM", commandId);
            if (outcome.kind === "FAILED") throw new Error(outcome.code);
            return outcome.kind === "COMMITTED";
          },
        });
      }
      return effects;
    }

    if (change.previousRevisionId) {
      // A correction withdraws open questions about the earlier representation.
      for (const recordId of await inquiriesForSource([change.previousRevisionId])) {
        effects.push({
          effectKey: `withdraw:${recordId}`,
          async run(commandId) {
            const chain = await readChain(recordId);
            if (!chain || !(OPEN_STATES as readonly string[]).includes(chain.current.payload.lifecycle.state)) return false;
            const outcome = await transition(chain, { state: "WITHDRAWN", withdrawnAt: dependencies.now(), reason: "EVIDENCE_CHANGED" }, "WITHDRAWN", commandId);
            if (outcome.kind === "FAILED") throw new Error(outcome.code);
            return outcome.kind === "COMMITTED";
          },
        });
      }
    }

    const resulting = { recordType: "MEDICATION_EVENT" as const, recordId: change.recordId as RecordId, revisionId: change.resultingRevisionId as RevisionId };
    effects.push({
      effectKey: `candidate:${change.resultingRevisionId}`,
      async run(commandId) {
        const basis = await basisFor(resulting);
        if (!basis || !basis.isCurrentHead) return false;
        const existing = await inquiriesForSource([resulting.revisionId]);
        const recordId = existing[0] ?? (await createCandidate(basis, commandId));
        if (!recordId) return false;
        const chain = await readChain(recordId);
        if (chain?.current.payload.lifecycle.state === "CANDIDATE") {
          const outcome = await assess(chain, await activeChains());
          if (outcome?.kind === "FAILED") throw new Error(outcome.code);
        }
        return existing.length === 0;
      },
    });
    return effects;
  }

  // --- presentation ---------------------------------------------------------------------------

  async function presentationContent(chain: Chain, locale: SupportedLocale) {
    const ref = basisRefOf(chain.current.payload);
    const definition = findInquiryDefinition(chain.current.payload.definition.definitionKey, chain.current.payload.definition.definitionVersion);
    if (!ref || !isEnabledDefinition(definition)) return null;
    const event = await readMedicationEvent(ref.revisionId);
    if (!event || (event.payload.state !== "MISSED" && event.payload.state !== "UNSURE")) return null;
    const occasion = exactOccasionOf(event.payload, manifest.medicationOccasionBarrier.homeUtcOffsetMinutes);
    const medicationRaw = await database.table("recordRevisions").get(event.payload.medication.revisionId);
    if (!occasion || medicationRaw === undefined) return null;
    const medication = carePlanRevisionRowCodec.validateAfterRead(medicationRaw).revision as MedicationRevision;
    const copy = dependencies.copy(locale);
    return renderBarrierContent(definition, copy.template, {
      statusLabel: copy.statusLabel(event.payload.state),
      medicineName: medication.payload.identity.patientEnteredName,
      dateText: copy.occasionDate(occasion.localDate),
    });
  }

  async function present(chain: Chain, locale: SupportedLocale): Promise<OfferResult> {
    const now = dependencies.now();
    const content = await presentationContent(chain, locale);
    const ref = basisRefOf(chain.current.payload)!;
    if (!content) {
      await transition(chain, { state: "WITHDRAWN", withdrawnAt: now, reason: "EVIDENCE_CHANGED" }, "WITHDRAWN");
      return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
    }
    const definition = barrier();
    const lifecycle: InquiryLifecycle = {
      state: "PRESENTED",
      presentation: {
        presentationKey: ids.presentationKey() as InquiryPresentationKey,
        presentedAt: now,
        presentationClass: definition.presentationClass,
        surface: "DIALOG",
        locale,
        content,
        wordingSource: {
          kind: "DETERMINISTIC_TEMPLATE",
          templateKey: definition.template.templateKey,
          templateVersion: definition.template.templateVersion,
        },
        revalidation: { evaluatedAt: now, ruleVersion: definition.ruleVersions.revalidation, outcome: "VALID_FOR_PRESENTATION", basisRevisions: [ref] },
      },
    } as InquiryLifecycle;
    const outcome = await transition(chain, lifecycle, "PRESENTED");
    if (outcome.kind !== "COMMITTED") return { kind: "NONE", reason: "STORAGE_UNAVAILABLE" };
    const presented = await readChain(chain.current.recordId);
    return presented ? { kind: "PRESENTED", question: questionView(presented, ref.recordId) } : { kind: "NONE", reason: "STORAGE_UNAVAILABLE" };
  }

  function questionView(chain: Chain, medicationEventRecordId: RecordId): PresentedBarrierQuestion {
    const lifecycle = chain.current.payload.lifecycle;
    if (lifecycle.state !== "PRESENTED") throw new Error("NOT_PRESENTED");
    const presentation = lifecycle.presentation;
    return {
      inquiryRecordId: chain.current.recordId,
      inquiryRevisionId: chain.current.revisionId,
      presentationKey: presentation.presentationKey,
      locale: presentation.locale,
      leadIn: presentation.content.leadIn ?? "",
      question: presentation.content.question,
      options: presentation.content.options.map((option) => ({ optionKey: option.optionKey, label: option.label })),
      medicationEventRecordId,
    };
  }

  async function chainForEvent(medicationEventRecordId: RecordId): Promise<Chain | null> {
    const head = await headOf(medicationEventRecordId);
    if (!head || head.state !== "ACTIVE") return null;
    const ids = await inquiriesForSource([head.headRevisionId]);
    for (const recordId of ids) {
      const chain = await readChain(recordId);
      if (chain) return chain;
    }
    return null;
  }

  async function offer(medicationEventRecordId: RecordId, locale: SupportedLocale): Promise<OfferResult> {
    let chain = await chainForEvent(medicationEventRecordId);
    if (!chain) return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
    const now = dependencies.now();
    let lifecycle = chain.current.payload.lifecycle;

    if (lifecycle.state === "PRESENTED") {
      if (presentationExpired(lifecycle.presentation, manifest, now)) {
        await transition(chain, { state: "EXPIRED", expiredAt: now, reason: "TIME_RELEVANCE_ENDED" }, "EXPIRED");
        return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      }
      // The already-presented question is the one concurrent inquiry; showing
      // it again in another locale is a meaning-preserving new presentation.
      if (lifecycle.presentation.locale === locale) return { kind: "PRESENTED", question: questionView(chain, medicationEventRecordId) };
      return present(chain, locale);
    }
    if (lifecycle.state === "SNOOZED") {
      if (Date.parse(now) < Date.parse(lifecycle.eligibleAgainAt)) return { kind: "NONE", reason: "SNOOZED" };
      const outcome = await assess(chain, await activeChains());
      if (outcome?.kind !== "COMMITTED") return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      chain = (await readChain(chain.current.recordId))!;
      lifecycle = chain.current.payload.lifecycle;
    }
    if (lifecycle.state === "ELIGIBLE") {
      const chains = await activeChains();
      const fresh = (await assess(chain, chains)) ?? null;
      if (fresh?.kind !== "COMMITTED") return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      chain = (await readChain(chain.current.recordId))!;
      if (chain.current.payload.lifecycle.state !== "ELIGIBLE") return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      const eligibleChains = (await activeChains()).filter((entry) => entry.current.payload.lifecycle.state === "ELIGIBLE");
      const definition = barrier();
      const candidates: ArbiterCandidate[] = [];
      for (const entry of eligibleChains) {
        const state = entry.current.payload.lifecycle;
        if (state.state !== "ELIGIBLE") continue;
        const basisRef = basisRefOf(entry.current.payload);
        const event = basisRef ? await readMedicationEvent(basisRef.revisionId) : null;
        const occasion = event ? exactOccasionOf(event.payload, manifest.medicationOccasionBarrier.homeUtcOffsetMinutes) : null;
        const firstEligible = entry.revisions.find((revision) => revision.payload.lifecycle.state === "ELIGIBLE");
        candidates.push({
          inquiryRecordId: entry.current.recordId,
          priorityRuleVersion: definition.ruleVersions.priority,
          presentationClass: definition.presentationClass,
          eligibility: state.assessment,
          expiresAt: entry.current.payload.expiresAt ?? null,
          firstEligibleAt: firstEligible?.revisionCreatedAt ?? entry.current.revisionCreatedAt,
          inCurrentView: entry.current.recordId === chain.current.recordId,
          relevantAt: occasion?.expectedAt ?? entry.current.recordedAt,
          boundedChoice: true,
        });
      }
      const decisions = arbitrateInquiries({ manifest, candidates, budget: budgetExcluding(chains, "", now), now });
      const mine = decisions.find((entry) => entry.inquiryRecordId === chain!.current.recordId)!;
      if (mine.decision.outcome !== "QUEUED") return { kind: "NONE", reason: "NOT_SELECTED" };
      const current = chain.current.payload.lifecycle;
      if (current.state !== "ELIGIBLE") return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      const queued = await transition(chain, { state: "QUEUED", eligibility: current.assessment, decision: { ...mine.decision, outcome: "QUEUED" } } as InquiryLifecycle, "QUEUED");
      if (queued.kind !== "COMMITTED") return { kind: "NONE", reason: "STORAGE_UNAVAILABLE" };
      chain = (await readChain(chain.current.recordId))!;
      lifecycle = chain.current.payload.lifecycle;
    }
    if (lifecycle.state === "QUEUED") {
      const chains = await activeChains();
      const ref = basisRefOf(chain.current.payload);
      const basis = ref ? await basisFor(ref) : null;
      const definition = barrier();
      if (!basis) {
        await transition(chain, { state: "WITHDRAWN", withdrawnAt: now, reason: "EVIDENCE_CHANGED" }, "WITHDRAWN");
        return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      }
      const outcome = revalidateForPresentation({
        definition,
        manifest,
        payload: chain.current.payload,
        basis,
        priors: priorsFor(chains, chain.current.payload.deduplicationKey, chain.current.recordId),
        budget: budgetExcluding(chains, chain.current.recordId, now),
        now,
      });
      if (outcome.kind === "DEFER") return { kind: "NONE", reason: "DEFERRED" };
      if (outcome.kind === "EXPIRE") {
        await transition(chain, { state: "EXPIRED", expiredAt: now, reason: outcome.reason }, "EXPIRED");
        return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      }
      if (outcome.kind === "WITHDRAW") {
        await transition(chain, { state: "WITHDRAWN", withdrawnAt: now, reason: outcome.reason }, "WITHDRAWN");
        return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
      }
      return present(chain, locale);
    }
    return { kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" };
  }

  // --- patient actions ------------------------------------------------------------------------

  async function presentedChain(inquiryRecordId: RecordId, presentationKey: string): Promise<Chain | InquiryActionResult> {
    const chain = await readChain(inquiryRecordId);
    if (!chain) return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
    const lifecycle = chain.current.payload.lifecycle;
    if ((ANSWER_STATES as readonly string[]).includes(lifecycle.state)) return { kind: "REJECTED", code: "INQUIRY_ALREADY_RESOLVED" };
    if (lifecycle.state !== "PRESENTED" || lifecycle.presentation.presentationKey !== presentationKey) {
      return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
    }
    if (presentationExpired(lifecycle.presentation, manifest, dependencies.now())) {
      await transition(chain, { state: "EXPIRED", expiredAt: dependencies.now(), reason: "TIME_RELEVANCE_ENDED" }, "EXPIRED");
      return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
    }
    return chain;
  }

  async function resolvedAfterConflict(inquiryRecordId: RecordId): Promise<InquiryActionResult> {
    const chain = await readChain(inquiryRecordId);
    const state = chain?.current.payload.lifecycle.state;
    return state && (ANSWER_STATES as readonly string[]).includes(state)
      ? { kind: "REJECTED", code: "INQUIRY_ALREADY_RESOLVED" }
      : { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
  }

  function actionResult(outcome: CommitOutcome, responseRecordId?: RecordId): InquiryActionResult {
    if (outcome.kind === "COMMITTED") return { kind: "COMMITTED", responseRecordId };
    if (outcome.kind === "REJECTED") return { kind: "REJECTED", code: "HEAD_CONFLICT" };
    return { kind: "FAILED", code: outcome.code };
  }

  /**
   * Captures one exact presentation-bound answer: the response revision and
   * the terminal Inquiry revision commit atomically. An exact retry with the
   * same command ID replays its receipt; any other submission after the
   * presentation is resolved returns `INQUIRY_ALREADY_RESOLVED`.
   */
  async function answer(input: { inquiryRecordId: RecordId; presentationKey: string; rawAnswer: InquiryRawAnswer; commandId: CommandId }): Promise<InquiryActionResult> {
    try {
      const commandHash = { inquiry: input.inquiryRecordId, presentationKey: input.presentationKey, rawAnswer: input.rawAnswer };
      const stored = await database.table("commandReceipts").get(input.commandId);
      if (stored !== undefined) {
        // Exact retry: return the stored result without creating duplicate truth.
        const receipt = implementedStorageRowCodecs.commandReceipts.validateAfterRead(stored);
        if (receipt.commandHash !== fingerprint({ commandName: "ANSWER_INQUIRY", content: commandHash })) return { kind: "FAILED", code: "VALIDATION_FAILED" };
        if (receipt.outcome === "COMMITTED") {
          const response = receipt.resultingRevisions.find((entry) => entry.recordId !== input.inquiryRecordId);
          return { kind: "COMMITTED", responseRecordId: response?.recordId };
        }
        return resolvedAfterConflict(input.inquiryRecordId);
      }
      const resolved = await presentedChain(input.inquiryRecordId, input.presentationKey);
      if (!("current" in resolved)) return resolved;
      const chain = resolved;
      const lifecycle = chain.current.payload.lifecycle;
      if (lifecycle.state !== "PRESENTED") return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      const now = dependencies.now();
      const built = buildBarrierResponseParts({ definition: barrier(), manifest, presentation: lifecycle.presentation, rawAnswer: input.rawAnswer, determinedAt: now });
      if (!built.ok) return { kind: "REJECTED", code: "ANSWER_NOT_PERMITTED" };
      const transactionId = ids.transactionId();
      const responseRecordId = ids.recordId();
      const { terminalState, ...parts } = built.parts;
      const response = {
        schemaVersion: 1,
        recordType: "INQUIRY_RESPONSE",
        recordId: responseRecordId,
        revisionId: ids.revisionId(),
        revisionNumber: 1,
        previousRevisionId: null,
        action: "CREATE",
        recordedAt: now,
        revisionCreatedAt: now,
        temporal: { kind: "ATEMPORAL" },
        provenance: PATIENT_INQUIRY,
        auditEventId: ids.auditEventId(),
        transactionId,
        payload: {
          inquiryPresentation: {
            inquiry: { recordType: "INQUIRY", recordId: chain.current.recordId, revisionId: chain.current.revisionId },
            presentationKey: lifecycle.presentation.presentationKey,
          },
          answeredAt: now,
          submittedThrough: lifecycle.presentation.surface,
          ...parts,
        },
      } as InquiryResponseRevision;
      const terminal = nextInquiryRevision(
        chain.current,
        { state: terminalState, response: { recordType: "INQUIRY_RESPONSE", recordId: responseRecordId, revisionId: response.revisionId } } as InquiryLifecycle,
        now,
        transactionId,
      );
      const outcome = await commit({
        commandName: "ANSWER_INQUIRY",
        hashMaterial: commandHash,
        commandId: input.commandId,
        transactionId,
        now,
        changes: [
          { kind: "REVISION", revision: response, expectedHead: null, eventId: ids.domainEventId(), eventName: "INQUIRY_RESPONSE_RECORDED", auditReason: "PATIENT_ANSWERED" },
          transitionChange(chain, terminal, "PATIENT_ANSWERED"),
        ],
      });
      if (outcome.kind === "REJECTED") return resolvedAfterConflict(input.inquiryRecordId);
      if (outcome.kind === "COMMITTED") {
        const created = outcome.resultingRevisions.find((entry) => entry.recordId !== input.inquiryRecordId);
        return { kind: "COMMITTED", responseRecordId: created?.recordId ?? responseRecordId };
      }
      return actionResult(outcome);
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  async function snooze(input: { inquiryRecordId: RecordId; presentationKey: string; choice: SnoozeChoice; commandId?: CommandId }): Promise<InquiryActionResult> {
    try {
      const resolved = await presentedChain(input.inquiryRecordId, input.presentationKey);
      if (!("current" in resolved)) return resolved;
      const now = dependencies.now();
      const until = snoozeUntil(manifest, input.choice, now, manifest.medicationOccasionBarrier.homeTimeZoneId);
      if (until.kind !== "ELIGIBLE_AGAIN_AT") return { kind: "FAILED", code: "TIMEZONE_RECONCILIATION_REQUIRED" };
      const outcome = await transition(
        resolved,
        {
          state: "SNOOZED",
          presentedRevision: { recordType: "INQUIRY", recordId: resolved.current.recordId, revisionId: resolved.current.revisionId },
          presentationKey: input.presentationKey,
          snoozedAt: now,
          eligibleAgainAt: until.eligibleAgainAt,
        } as InquiryLifecycle,
        "PATIENT_SNOOZED",
        input.commandId,
      );
      return outcome.kind === "REJECTED" ? resolvedAfterConflict(input.inquiryRecordId) : actionResult(outcome);
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  async function dismiss(input: { inquiryRecordId: RecordId; presentationKey: string; commandId?: CommandId }): Promise<InquiryActionResult> {
    try {
      const resolved = await presentedChain(input.inquiryRecordId, input.presentationKey);
      if (!("current" in resolved)) return resolved;
      const outcome = await transition(
        resolved,
        {
          state: "DISMISSED",
          presentedRevision: { recordType: "INQUIRY", recordId: resolved.current.recordId, revisionId: resolved.current.revisionId },
          presentationKey: input.presentationKey,
          dismissedAt: dependencies.now(),
        } as InquiryLifecycle,
        "PATIENT_DISMISSED",
        input.commandId,
      );
      return outcome.kind === "REJECTED" ? resolvedAfterConflict(input.inquiryRecordId) : actionResult(outcome);
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  async function readResponse(responseRecordId: RecordId): Promise<{ head: RecordHead; current: InquiryResponseRevision } | null> {
    const head = await headOf(responseRecordId);
    if (!head || head.state !== "ACTIVE" || head.recordType !== "INQUIRY_RESPONSE") return null;
    const current = inquiryOwnedRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as InquiryResponseRevision;
    return { head, current };
  }

  /**
   * A patient correction of a recorded answer: both response revisions stay in
   * history, the same exact presentation and answer contract apply, and the
   * Inquiry gains a new terminal revision for the corrected response.
   */
  async function correctResponse(input: { responseRecordId: RecordId; rawAnswer: InquiryRawAnswer; commandId: CommandId }): Promise<InquiryActionResult> {
    try {
      const response = await readResponse(input.responseRecordId);
      if (!response) return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      const presentedRef = response.current.payload.inquiryPresentation;
      const chain = await readChain(presentedRef.inquiry.recordId);
      const presented = chain?.revisions.find((revision) => revision.revisionId === presentedRef.inquiry.revisionId);
      if (!chain || !presented || presented.payload.lifecycle.state !== "PRESENTED") return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      if (!(ANSWER_STATES as readonly string[]).includes(chain.current.payload.lifecycle.state)) return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      const now = dependencies.now();
      const built = buildBarrierResponseParts({ definition: barrier(), manifest, presentation: presented.payload.lifecycle.presentation, rawAnswer: input.rawAnswer, determinedAt: now });
      if (!built.ok) return { kind: "REJECTED", code: "ANSWER_NOT_PERMITTED" };
      const transactionId = ids.transactionId();
      const { terminalState, ...parts } = built.parts;
      const corrected = {
        ...response.current,
        revisionId: ids.revisionId(),
        revisionNumber: response.current.revisionNumber + 1,
        previousRevisionId: response.current.revisionId,
        action: "CORRECT",
        revisionCreatedAt: now,
        provenance: PATIENT_INQUIRY,
        auditEventId: ids.auditEventId(),
        transactionId,
        // The exact presentation, first answeredAt and surface never change.
        payload: { ...response.current.payload, ...parts },
      } as InquiryResponseRevision;
      const terminal = nextInquiryRevision(
        chain.current,
        { state: terminalState, response: { recordType: "INQUIRY_RESPONSE", recordId: corrected.recordId, revisionId: corrected.revisionId } } as InquiryLifecycle,
        now,
        transactionId,
      );
      const outcome = await commit({
        commandName: "CORRECT_INQUIRY_RESPONSE",
        hashMaterial: { response: input.responseRecordId, expected: response.head.headRevisionId, rawAnswer: input.rawAnswer },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [
          { kind: "REVISION", revision: corrected, expectedHead: response.head, eventId: ids.domainEventId(), eventName: "INQUIRY_RESPONSE_CORRECTED", auditReason: "PATIENT_CORRECTED_ANSWER" },
          transitionChange(chain, terminal, "PATIENT_CORRECTED_ANSWER"),
        ],
      });
      return actionResult(outcome, input.responseRecordId);
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  /** Patient removal: the answer and the exact question it answered are deleted together. */
  async function removeResponse(input: { responseRecordId: RecordId; commandId?: CommandId }): Promise<InquiryActionResult> {
    try {
      const response = await readResponse(input.responseRecordId);
      if (!response) return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      const chain = await readChain(response.current.payload.inquiryPresentation.inquiry.recordId);
      if (!chain) return { kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" };
      return actionResult(await deleteChain(chain, "PATIENT_DELETED", "PATIENT", input.commandId));
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  /** Expires questions whose answerability or presentation window has ended. */
  async function maintain(): Promise<void> {
    const now = dependencies.now();
    for (const chain of await activeChains()) {
      const lifecycle = chain.current.payload.lifecycle;
      if (!(OPEN_STATES as readonly string[]).includes(lifecycle.state)) continue;
      const expiresAt = chain.current.payload.expiresAt;
      if (expiresAt && Date.parse(now) >= Date.parse(expiresAt)) {
        await transition(chain, { state: "EXPIRED", expiredAt: now, reason: "ANSWERABILITY_ENDED" }, "EXPIRED");
      } else if (lifecycle.state === "PRESENTED" && presentationExpired(lifecycle.presentation, manifest, now)) {
        await transition(chain, { state: "EXPIRED", expiredAt: now, reason: "TIME_RELEVANCE_ENDED" }, "EXPIRED");
      }
    }
  }

  return Object.freeze({
    async processPending(): Promise<OwnedWorkReport> {
      return runOwnedWork({
        database,
        now: dependencies.now,
        newCommandId: ids.commandId,
        leaseToken: ids.leaseToken(),
        instanceId: dependencies.instanceId,
        consumer: "INQUIRY_ELIGIBILITY",
        handlerVersion: INQUIRY_ELIGIBILITY_HANDLER_VERSION,
        plan: (item) => eligibilityEffects(item.eventId),
      });
    },
    async offerForMedicationEvent(medicationEventRecordId: RecordId, locale: SupportedLocale): Promise<OfferResult> {
      try {
        return await offer(medicationEventRecordId, locale);
      } catch {
        return { kind: "NONE", reason: "STORAGE_UNAVAILABLE" };
      }
    },
    answer,
    snooze,
    dismiss,
    correctResponse,
    removeResponse,
    maintain,
  });
}
