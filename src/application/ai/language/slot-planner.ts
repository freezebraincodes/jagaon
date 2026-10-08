import { deepFreeze } from "@/application/deep-freeze";
import { aiTaskRequestSchema, sectionBulletPath, sectionIntroPath, SLOT_PLAN_VERSION, slotTokenMatcher, type AiLocale, type AiTaskRequest, type AtomEntry, type AtomKind, type AtomTable, type FieldOwner, type GlossKey, type PlannedSection, type ProviderFact, type RemoteEligibility, type ShellFieldPath, type ShellFieldSpec, type ShellTask, type SlotDefinition, type SlotId, type SlotPlan } from "@/domain/ai";
import type { PeriodSummaryBinding } from "@/domain/ai/ai-task-contracts";
import type { AiHybridRuntimeBundle } from "../ai-hybrid-runtime-bundles";
import { OUTPUT_CODE_POINTS_PER_TOKEN } from "../ai-output-validator";
import { projectProviderTaskPayload } from "../detached-payload-projector";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";
import { assembleField, validationViewJoin } from "./assembler";
import { isDisplayUnit, renderAtom, type AtomSource } from "./atom-renderer";
import { defaultShells } from "./default-shells";
import { composeLocalShells, isObservationCompositionError, observationVariantCount } from "./observation-composer";
import { approvedSectionHeading } from "./shell-projector";

/**
 * Packet 11B.6 deterministic slot planner (spec Sections 6.1, 6.6). Every supplied fact becomes exactly one
 * atom bound to one home field. Anything without a rule fails closed.
 *
 * ai-slot-plan.11b.7 (Packet 11B.7 hardening, owner decisions 3 and 5): every maxCodePoints comes from the
 * fixed task x locale x field-kind table below and never depends on an atom's length; the planner never
 * shrinks a budget. A plan whose fixed budgets plus atoms do not fit a field's schema limit or the output
 * ceiling, or that carries a section with no approved heading in its locale (today Symptoms and context and
 * Patterns; a heading is never invented, and approving one later makes the section eligible), is still
 * PLANNED but remote-ineligible: the service composes it deterministically without a provider call. A plan
 * is UNPLANNABLE only when even its deterministic composition (approved default shells around the atoms)
 * could not fit, or when the payload has no rule.
 *
 * ai-slot-plan.11b.8 (observation ownership, owner instruction 2026-10-07, offline): every field names its owner. The EXPLAIN
 * headline and evidence are REMOTE (model-written); the EXPLAIN observation is LOCAL (composed by the application's observation
 * composer); every care field is REMOTE. Fields, slots, slot ids, order, budgets and eligibility are otherwise unchanged.
 *
 * Packet 11C (2026-10-08, offline): a source-backed EXPLAIN request (one carrying the local `periodSummary` binding) takes its own
 * branch (`sourceBackedExplainPlan`), which keeps the existing S1 MEANING headline / S3 COUNT evidence remote shape and puts every period
 * fact into one LOCAL PERIOD_SUMMARY observation atom. Requests without the binding are planned exactly as before.
 *
 * ai-slot-plan.11b.9 (Packet 11C phase 2, owner decision option (a), 2026-10-08, offline): remote eligibility reserves an application-owned
 * (LOCAL) field at its actual final wording instead of its fixed budget: the code points of the text the observation composer and the
 * assembler will emit (approved prose, spacing, punctuation and each atom exactly once, so no atom cost is added on top), as the maximum
 * over every permitted local variant (`remoteBudgetAccount`). The variant is not fixed by the plan: the AI-path composition step
 * (`composeAiResult`) uses the variant selected from the requestId, or one its caller supplies (the evaluation replays compose every plan in
 * variants 1 and 2), and `composeLocalShells` accepts 0..N; eligibility must not depend on the requestId. A LOCAL field one of whose
 * permitted variants cannot be composed is never remote-eligible. REMOTE fields keep their fixed budget + atoms + ATOM_SPACING_RESERVE;
 * FIXED_FIELD_BUDGETS, FIELD_SCHEMA_LIMITS, the output ceiling, the default-shell checks and deterministicFits are unchanged, and every
 * field's maxCodePoints is still its fixed budget. The rule changes for every plan, hence the version; the only model-facing difference is
 * this version string (documented and enforced by the evaluation version-only guard).
 */
export type FieldKind = "headline" | "observation" | "evidence" | "intro" | "bullet";
export const FIXED_FIELD_BUDGETS = deepFreeze({
  EXPLAIN_PATTERN: { "en-SG": { headline: 60, observation: 120, evidence: 80 }, "zh-SG": { headline: 50, observation: 90, evidence: 60 } },
  DRAFT_CARE_PREPARATION_SUMMARY: { "en-SG": { intro: 60, bullet: 40 }, "zh-SG": { intro: 30, bullet: 24 } },
} as const) satisfies Readonly<Record<ShellTask, Readonly<Record<AiLocale, Readonly<Partial<Record<FieldKind, number>>>>>>>;
/** A section intro is validated as the prefix of its first bullet (the care validation view), so it shares the bullet limit. */
export const FIELD_SCHEMA_LIMITS = Object.freeze({ headline: 160, observation: 600, evidence: 600, intro: 400, bullet: 400 } as const);
export const ATOM_SPACING_RESERVE = 2;
export type UnplannableReason = "PAYLOAD_INVALID" | "PRIVACY_REJECTED" | "BUDGET_EXCEEDED";
export type SlotPlanResult = Readonly<{ kind: "PLANNED"; plan: SlotPlan; atoms: AtomTable }> | Readonly<{ kind: "UNPLANNABLE"; reason: UnplannableReason }>;

class Unplannable extends Error {
  constructor(readonly reason: UnplannableReason) { super(reason); }
}
const stop = (reason: UnplannableReason): never => { throw new Unplannable(reason); };
const cp = (text: string) => [...text].length;

type Draft = { slotId: SlotId; atomKind: AtomKind; homeField: ShellFieldPath; boundRefs: string[]; orderGroup: string | null; glossKey: GlossKey; source: AtomSource };
type DraftField = Omit<ShellFieldSpec, "maxCodePoints"> & { kind: FieldKind; first?: boolean };

function explainPlan(request: Extract<AiTaskRequest, { taskType: "EXPLAIN_PATTERN" }>, facts: readonly ProviderFact[]): { drafts: Draft[]; fields: DraftField[] } {
  const claim = request.taskPayload.claim;
  const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
  if (facts.some((fact) => !claim.factRefs.includes(fact.ref))) stop("PAYLOAD_INVALID");
  const groups = { values: [] as ProviderFact[], dates: [] as ProviderFact[], ranges: [] as ProviderFact[], times: [] as ProviderFact[], items: [] as ProviderFact[] };
  const counts: ProviderFact[] = [];
  for (const ref of claim.factRefs) {
    const fact = byRef.get(ref) ?? stop("PAYLOAD_INVALID");
    const key = `${fact.field}:${fact.value.kind}`;
    if (key === "MEASUREMENT_VALUE:DECIMAL") groups.values.push(fact);
    else if (key === "OCCURRENCE_TIME:DATE") groups.dates.push(fact);
    else if (key === "EFFECTIVE_INTERVAL:DATE_RANGE") groups.ranges.push(fact);
    else if (key === "OCCURRENCE_TIME:LOCAL_TIME") groups.times.push(fact);
    else if (key === "INTAKE_LABEL:TEXT" || key === "ACTIVITY_LABEL:TEXT") groups.items.push(fact);
    else if (key === "EVIDENCE_COUNT:COUNT") counts.push(fact);
    else stop("PAYLOAD_INVALID");
  }
  const units = new Set(groups.values.map((fact) => (fact.value as { unit: string }).unit));
  if (units.size > 1 || [...units].some((unit) => !isDisplayUnit(unit)) || counts.length > 1) stop("PAYLOAD_INVALID");
  const present = (Object.keys(groups) as Array<keyof typeof groups>).filter((key) => groups[key].length > 0);
  if (present.length < 1 || present.length > 2) stop("PAYLOAD_INVALID");

  const drafts: Draft[] = [];
  const next = (): SlotId => `S${drafts.length + 1}`;
  drafts.push({ slotId: next(), atomKind: "MEANING", homeField: "headline", boundRefs: [claim.ref], orderGroup: null, glossKey: "MEANING_CLAUSE", source: { kind: "MEANING", family: claim.family } });
  if (groups.values.length > 0) drafts.push({ slotId: next(), atomKind: "DECIMAL_LIST", homeField: "observation", boundRefs: groups.values.map((fact) => fact.ref), orderGroup: null, glossKey: "RECORDED_VALUES", source: { kind: "DECIMAL_LIST", values: groups.values.map((fact) => ({ value: (fact.value as { value: string }).value, unit: (fact.value as { unit: string }).unit })) } });
  for (const fact of groups.dates) drafts.push({ slotId: next(), atomKind: "DATE", homeField: "observation", boundRefs: [fact.ref], orderGroup: "dates", glossKey: "RECORDED_DATE", source: { kind: "DATE", localDate: (fact.value as { localDate: string }).localDate } });
  for (const fact of groups.ranges) drafts.push({ slotId: next(), atomKind: "DATE_RANGE", homeField: "observation", boundRefs: [fact.ref], orderGroup: "ranges", glossKey: "RECORDED_DATE_RANGE", source: { kind: "DATE_RANGE", startDate: (fact.value as { startDate: string }).startDate, endDate: (fact.value as { endDate: string }).endDate } });
  for (const fact of groups.times) drafts.push({ slotId: next(), atomKind: "TIME", homeField: "observation", boundRefs: [fact.ref], orderGroup: "times", glossKey: "RECORDED_TIME", source: { kind: "TIME", localTime: (fact.value as { localTime: string }).localTime } });
  for (const fact of groups.items) drafts.push({ slotId: next(), atomKind: "LABEL", homeField: "observation", boundRefs: [fact.ref], orderGroup: "items", glossKey: "RECORDED_ITEM", source: { kind: "LABEL", text: (fact.value as { text: string }).text } });
  for (const fact of counts) drafts.push({ slotId: next(), atomKind: "COUNT", homeField: "evidence", boundRefs: [fact.ref], orderGroup: null, glossKey: "EVIDENCE_COUNT", source: { kind: "COUNT", value: (fact.value as { value: number }).value, noun: claim.family === "COMPARABLE_SLOT_TREND" ? "READINGS" : "RECORDS" } });
  const slotsOf = (field: ShellFieldPath) => drafts.filter((draft) => draft.homeField === field).map((draft) => draft.slotId);
  return {
    drafts,
    fields: [
      { path: "headline", requiredSlots: slotsOf("headline"), maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE", kind: "headline" },
      { path: "observation", requiredSlots: slotsOf("observation"), maxSentences: 2, mayBeAtomOnly: false, owner: "LOCAL", kind: "observation" },
      { path: "evidence", requiredSlots: slotsOf("evidence"), maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE", kind: "evidence" },
    ],
  };
}

/**
 * Packet 11C source-backed EXPLAIN branch, taken only when the request carries the local `periodSummary` binding (it is never projected).
 * The claim binds to MEANING S1 (headline, REMOTE); all six period facts (each period's interval, count and summary value, EARLIER then
 * RECENT) bind to one application-owned PERIOD_SUMMARY S2 (observation, LOCAL, glossKey RECORDED_VALUES, never projectable); the total
 * binds to COUNT S3 (evidence, REMOTE, EVIDENCE_COUNT, READINGS noun). So the remote request keeps the existing S1/S3 shape. Every other
 * combination (a fact outside the binding, a wrong kind or unit, a total that is not the sum, another family) is PAYLOAD_INVALID.
 */
function sourceBackedExplainPlan(request: Extract<AiTaskRequest, { taskType: "EXPLAIN_PATTERN" }>, facts: readonly ProviderFact[], binding: PeriodSummaryBinding): { drafts: Draft[]; fields: DraftField[] } {
  const claim = request.taskPayload.claim;
  if (claim.family !== "COMPARABLE_SLOT_TREND") stop("PAYLOAD_INVALID");
  const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
  const periodRefs = binding.periods.flatMap((period) => [period.intervalRef, period.countRef, period.summaryRef]);
  const bound = [...periodRefs, binding.totalCountRef];
  // Exact-once binding: the bound refs are exactly the claim facts and the supplied facts, each once.
  if (new Set(bound).size !== bound.length || bound.length !== claim.factRefs.length || bound.length !== facts.length || bound.some((ref) => !claim.factRefs.includes(ref) || !byRef.has(ref))) stop("PAYLOAD_INVALID");
  const valueOf = (ref: string, key: string) => {
    const fact = byRef.get(ref) ?? stop("PAYLOAD_INVALID");
    if (`${fact.field}:${fact.value.kind}` !== key) stop("PAYLOAD_INVALID");
    return fact.value as Record<string, unknown>;
  };
  const periods = binding.periods.map((period, index) => {
    if (period.role !== (["EARLIER", "RECENT"] as const)[index]) stop("PAYLOAD_INVALID");
    const interval = valueOf(period.intervalRef, "EFFECTIVE_INTERVAL:DATE_RANGE");
    const count = valueOf(period.countRef, "EVIDENCE_COUNT:COUNT");
    const summary = valueOf(period.summaryRef, "MEASUREMENT_VALUE:DECIMAL");
    if (summary.unit !== "MMOL_L") stop("PAYLOAD_INVALID");
    return { role: period.role, startDate: interval.startDate as string, endDate: interval.endDate as string, count: count.value as number, value: summary.value as string };
  });
  const total = valueOf(binding.totalCountRef, "EVIDENCE_COUNT:COUNT").value as number;
  if (periods.length !== 2 || periods.reduce((sum, period) => sum + period.count, 0) !== total) stop("PAYLOAD_INVALID");
  const drafts: Draft[] = [
    { slotId: "S1", atomKind: "MEANING", homeField: "headline", boundRefs: [claim.ref], orderGroup: null, glossKey: "MEANING_CLAUSE", source: { kind: "MEANING", family: claim.family } },
    { slotId: "S2", atomKind: "PERIOD_SUMMARY", homeField: "observation", boundRefs: periodRefs, orderGroup: null, glossKey: "RECORDED_VALUES", source: { kind: "PERIOD_SUMMARY", slot: binding.slot, summaryKind: binding.summaryKind, periods } },
    { slotId: "S3", atomKind: "COUNT", homeField: "evidence", boundRefs: [binding.totalCountRef], orderGroup: null, glossKey: "EVIDENCE_COUNT", source: { kind: "COUNT", value: total, noun: "READINGS" } },
  ];
  return {
    drafts,
    fields: [
      { path: "headline", requiredSlots: ["S1"], maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE", kind: "headline" },
      { path: "observation", requiredSlots: ["S2"], maxSentences: 2, mayBeAtomOnly: false, owner: "LOCAL", kind: "observation" },
      { path: "evidence", requiredSlots: ["S3"], maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE", kind: "evidence" },
    ],
  };
}

function careAtom(fact: ProviderFact): { atomKind: AtomKind; glossKey: GlossKey; source: AtomSource } {
  const key = `${fact.field}:${fact.value.kind}`;
  const value = fact.value as Record<string, unknown>;
  if (key === "MEASUREMENT_VALUE:DECIMAL") {
    if (!isDisplayUnit(value.unit as string)) stop("PAYLOAD_INVALID");
    return { atomKind: "DECIMAL", glossKey: "RECORDED_VALUE", source: { kind: "DECIMAL", value: value.value as string, unit: value.unit as string } };
  }
  if (key === "OCCURRENCE_TIME:DATE" || key === "APPOINTMENT_TIME:DATE") return { atomKind: "DATE", glossKey: "RECORDED_DATE", source: { kind: "DATE", localDate: value.localDate as string } };
  if (key === "EFFECTIVE_INTERVAL:DATE_RANGE") return { atomKind: "DATE_RANGE", glossKey: "RECORDED_DATE_RANGE", source: { kind: "DATE_RANGE", startDate: value.startDate as string, endDate: value.endDate as string } };
  if (key === "OCCURRENCE_TIME:LOCAL_TIME") return { atomKind: "TIME", glossKey: "RECORDED_TIME", source: { kind: "TIME", localTime: value.localTime as string } };
  if (key === "APPOINTMENT_SERVICE:TEXT") return { atomKind: "LABEL", glossKey: "APPOINTMENT_SERVICE", source: { kind: "LABEL", text: value.text as string } };
  if (key === "INTAKE_LABEL:TEXT" || key === "ACTIVITY_LABEL:TEXT" || key === "CARE_ITEM_LABEL:TEXT") return { atomKind: "LABEL", glossKey: "RECORDED_ITEM", source: { kind: "LABEL", text: value.text as string } };
  if (key === "QUESTION_TEXT:TEXT") return { atomKind: "QUOTED_TEXT", glossKey: "PATIENT_QUESTION", source: { kind: "QUOTED_TEXT", text: value.text as string } };
  if (key === "EVIDENCE_COUNT:COUNT") return { atomKind: "COUNT", glossKey: "EVIDENCE_COUNT", source: { kind: "COUNT", value: value.value as number, noun: "RECORDS" } };
  return stop("PAYLOAD_INVALID");
}

function carePlan(request: Extract<AiTaskRequest, { taskType: "DRAFT_CARE_PREPARATION_SUMMARY" }>, facts: readonly ProviderFact[], locale: AiLocale, copy: LanguageCopy) {
  const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
  const drafts: Draft[] = [];
  const fields: DraftField[] = [];
  const sections: PlannedSection[] = [];
  let deterministicOnly = false;
  request.taskPayload.sections.forEach((section, index) => {
    const introPath = sectionIntroPath(index);
    fields.push({ path: introPath, requiredSlots: [], maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE", kind: "intro" });
    const bulletPaths: ShellFieldPath[] = [];
    const refs = [...section.factRefs];
    for (let position = 0; position < refs.length; position += 1) {
      const fact = byRef.get(refs[position]!) ?? stop("PAYLOAD_INVALID");
      const following = refs[position + 1] ? byRef.get(refs[position + 1]!) : undefined;
      const pair = fact.field === "APPOINTMENT_SERVICE" && following?.field === "APPOINTMENT_TIME" ? [fact, following] : [fact];
      const path = sectionBulletPath(index, bulletPaths.length);
      const slotIds = pair.map((entry) => {
        const atom = careAtom(entry);
        const slotId: SlotId = `S${drafts.length + 1}`;
        drafts.push({ slotId, ...atom, homeField: path, boundRefs: [entry.ref], orderGroup: pair.length === 2 ? `appointment-${index}` : null });
        return slotId;
      });
      fields.push({ path, requiredSlots: slotIds, maxSentences: 1, mayBeAtomOnly: true, owner: "REMOTE", kind: "bullet", first: bulletPaths.length === 0 });
      bulletPaths.push(path);
      position += pair.length - 1;
    }
    // Decision 5: a section with no approved heading (Symptoms and context, Patterns) is never given an invented
    // heading; the plan stays deterministic, with the approved default intro (fail closed if there is none).
    const heading = approvedSectionHeading(locale, section.sectionId);
    if (heading === null) {
      if (copy.careIntros[section.sectionId]?.[locale] === undefined) stop("PAYLOAD_INVALID");
      deterministicOnly = true;
    }
    sections.push({ sectionSlot: `C${index + 1}`, sectionRef: section.ref, sectionId: section.sectionId, heading, introPath, bulletPaths });
  });
  if (drafts.length > 32) stop("PAYLOAD_INVALID");
  // Exact-once binding: a fact referenced by no section would vanish, one referenced twice would become two atoms.
  const bound = drafts.flatMap((draft) => draft.boundRefs);
  if (new Set(bound).size !== bound.length || bound.length !== facts.length) stop("PAYLOAD_INVALID");
  return { drafts, fields, sections, deterministicOnly };
}

export type FieldReservation = Readonly<{ path: ShellFieldPath; owner: FieldOwner; reserved: number }>;
export type RemoteBudgetAccount = Readonly<{ ceiling: number; total: number; fields: readonly FieldReservation[] }>;

/**
 * ai-slot-plan.11b.9: the code points a LOCAL field's final wording occupies, as the maximum over every permitted local variant (0..N), each
 * composed by the observation composer and assembled with the plan's atoms by the assembler, exactly as the AI path does. Throws
 * OBSERVATION_COMPOSITION_INVALID when a permitted variant cannot be composed.
 */
function localReservation(plan: SlotPlan, atoms: AtomTable, path: ShellFieldPath, copy: LanguageCopy): number {
  let reserved = 0;
  for (let variant = 0; variant <= observationVariantCount(plan.locale, copy); variant += 1) {
    const shell = composeLocalShells(plan, variant, copy).get(path);
    if (shell === undefined) throw new Error("OBSERVATION_COMPOSITION_INVALID");
    reserved = Math.max(reserved, cp(assembleField(shell, atoms, plan.locale).text));
  }
  return reserved;
}

/**
 * ai-slot-plan.11b.9 remote-eligibility account of a plan: per field, the code points reserved for it under the output ceiling (REMOTE: the
 * fixed budget, which is the field's maxCodePoints, plus every atom and ATOM_SPACING_RESERVE per atom; LOCAL: `localReservation`), their
 * total and the ceiling floor(outputTokenCeiling x OUTPUT_CODE_POINTS_PER_TOKEN) minus the care validation-view joins.
 */
export function remoteBudgetAccount(plan: SlotPlan, atoms: AtomTable, bundle: AiHybridRuntimeBundle, copy: LanguageCopy = AI_LANGUAGE_COPY): RemoteBudgetAccount {
  const atomCost = (slots: readonly SlotId[]) => slots.reduce((sum, slot) => sum + cp(atoms[slot]!.text) + ATOM_SPACING_RESERVE, 0);
  const fields = plan.fields.map((field) => Object.freeze({ path: field.path, owner: field.owner, reserved: field.owner === "LOCAL" ? localReservation(plan, atoms, field.path, copy) : field.maxCodePoints + atomCost(field.requiredSlots) }));
  const ceiling = Math.floor(bundle.executionBudget.outputTokenCeiling * OUTPUT_CODE_POINTS_PER_TOKEN) - plan.sections.length * cp(validationViewJoin(plan.locale));
  return Object.freeze({ ceiling, total: fields.reduce((sum, field) => sum + field.reserved, 0), fields: Object.freeze(fields) });
}

export function planSlots(request: AiTaskRequest, bundle: AiHybridRuntimeBundle, copy: LanguageCopy = AI_LANGUAGE_COPY): SlotPlanResult {
  try {
    const parsed = aiTaskRequestSchema.safeParse(request);
    if (!parsed.success || request.runtimeBundleKey !== bundle.bundleKey || request.taskType !== bundle.taskType) return { kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" };
    if (request.taskType !== "EXPLAIN_PATTERN" && request.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY") return { kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" };
    const task: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY" = request.taskType;
    const projection = projectProviderTaskPayload(request, bundle);
    if (projection.kind === "FALLBACK") return { kind: "UNPLANNABLE", reason: projection.reason };
    const facts = projection.payload.facts;
    const explain = (explainRequest: Extract<AiTaskRequest, { taskType: "EXPLAIN_PATTERN" }>) => {
      // Packet 11C: the source-backed branch only when the local binding is present; otherwise the existing branch, unchanged.
      const binding = explainRequest.taskPayload.periodSummary;
      return { ...(binding === undefined ? explainPlan(explainRequest, facts) : sourceBackedExplainPlan(explainRequest, facts, binding)), sections: [] as PlannedSection[], deterministicOnly: false };
    };
    const built = request.taskType === "EXPLAIN_PATTERN" ? explain(request) : request.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" ? carePlan(request, facts, request.locale, copy) : stop("PAYLOAD_INVALID");
    const atoms: Partial<Record<SlotId, AtomEntry>> = {};
    for (const draft of built.drafts) {
      let text: string;
      try { text = renderAtom(draft.source, request.locale, copy); } catch { return stop("PAYLOAD_INVALID"); }
      atoms[draft.slotId] = Object.freeze({ text, boundRefs: Object.freeze([...draft.boundRefs]) });
    }
    const atomCost = (slots: readonly SlotId[]) => slots.reduce((sum, slot) => sum + cp(atoms[slot]!.text) + ATOM_SPACING_RESERVE, 0);
    const budgets: Readonly<Partial<Record<FieldKind, number>>> = FIXED_FIELD_BUDGETS[task][request.locale];
    const budgetOf = (kind: FieldKind): number => budgets[kind] ?? stop("PAYLOAD_INVALID");
    const fields: ShellFieldSpec[] = built.fields.map(({ path, requiredSlots, maxSentences, mayBeAtomOnly, owner, kind }) => Object.freeze({ path, requiredSlots: Object.freeze([...requiredSlots]), maxCodePoints: budgetOf(kind), maxSentences, mayBeAtomOnly, owner }));
    const slots: SlotDefinition[] = built.drafts.map(({ source: _source, ...slot }) => Object.freeze({ ...slot, boundRefs: Object.freeze([...slot.boundRefs]) }));
    const sections = Object.freeze(built.sections.map((section) => Object.freeze({ ...section, bulletPaths: Object.freeze([...section.bulletPaths]) })));
    const claimFamily = request.taskType === "EXPLAIN_PATTERN" ? request.taskPayload.claim.family : null;
    const draftPlan: SlotPlan = { planVersion: SLOT_PLAN_VERSION, taskType: task, locale: request.locale, runtimeBundleKey: bundle.bundleKey, claimFamily, fields: Object.freeze(fields), slots: Object.freeze(slots), sections, remote: { eligible: true } };

    // The approved default shells around the atoms (the deterministic composition) must always fit: the field
    // schema limits, with each care intro counted in its section's first bullet, and the output ceiling.
    const defaults = defaultShells(draftPlan, copy);
    const prose = (path: ShellFieldPath) => cp((defaults.get(path) ?? "").replace(slotTokenMatcher(), ""));
    const join = cp(validationViewJoin(request.locale));
    const limitOf = (kind: FieldKind) => FIELD_SCHEMA_LIMITS[kind];
    const introOf = (path: ShellFieldPath) => built.sections.find((section) => section.bulletPaths[0] === path)?.introPath ?? stop("PAYLOAD_INVALID");
    const viewJoins = built.sections.length * join;
    const ceiling = Math.floor(bundle.executionBudget.outputTokenCeiling * OUTPUT_CODE_POINTS_PER_TOKEN) - viewJoins;
    const deterministicFits =
      built.fields.every((field) => prose(field.path) + atomCost(field.requiredSlots) + (field.first ? prose(introOf(field.path)) + join : 0) <= limitOf(field.kind)) &&
      built.fields.reduce((sum, field) => sum + prose(field.path) + atomCost(field.requiredSlots), 0) <= ceiling;
    if (!deterministicFits) stop("BUDGET_EXCEEDED");

    // Remote eligibility (decision 3; ai-slot-plan.11b.9): REMOTE fields at their fixed budgets, LOCAL fields at their final composed
    // wording (`remoteBudgetAccount`). A failed check never shrinks a budget; a LOCAL variant that cannot be composed is not eligible.
    const introBudget = request.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" ? budgetOf("intro") : 0;
    const account = ((): RemoteBudgetAccount | null => {
      try {
        return remoteBudgetAccount(draftPlan, atoms, bundle, copy);
      } catch (error) {
        if (!isObservationCompositionError(error) && !(error instanceof Error && error.message === "OBSERVATION_COMPOSITION_INVALID")) throw error;
        return null;
      }
    })();
    const fixedFits =
      account !== null &&
      built.fields.every((field) => budgetOf(field.kind) >= cp((defaults.get(field.path) ?? "").replace(slotTokenMatcher(), "").trim())) &&
      built.fields.every((field, index) => account.fields[index]!.reserved + (field.first ? introBudget + join : 0) <= limitOf(field.kind)) &&
      account.total <= account.ceiling;
    const remote: RemoteEligibility = built.deterministicOnly ? { eligible: false, reason: "PAYLOAD_INVALID" } : fixedFits ? { eligible: true } : { eligible: false, reason: "BUDGET_EXCEEDED" };
    const plan: SlotPlan = Object.freeze({ ...draftPlan, remote: Object.freeze(remote) });
    return { kind: "PLANNED", plan, atoms: Object.freeze(atoms) };
  } catch (error) {
    if (error instanceof Unplannable) return { kind: "UNPLANNABLE", reason: error.reason };
    throw error;
  }
}
