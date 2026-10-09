import type { Instant } from "@/domain/shared";
import { careSummaryAiReplacementIssues, careSummarySnapshotPayloadSchema, type CareSummaryBlock, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { remoteTokenInventory, SHELL_OUTPUT_VERSIONS, slotToken, type AtomTable, type ShellFieldPath, type SlotPlan } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { validateShellCandidate } from "@/application/ai/language/shell-validator";
import { planSlots } from "@/application/ai/language/slot-planner";
import { buildCareSummaryAiRequest, type CareSummaryAiRequestRefusal } from "./ai-care-summary-request";
import { careSummaryAiMarkingIssues } from "./care-summary-ai-marking";
import { renderAiAssistedCareSummary } from "./deterministic-care-summary-renderer";

/**
 * Packet 11C Addendum B, Task B1b (original Task 1 Step 4): the AI-assisted replacement payload of the current deterministic snapshot.
 *
 * Nothing in the composition is trusted. The request is rebuilt from `current` (`buildCareSummaryAiRequest`, with the audit ref as its
 * request id) and planned again, so every atom (value, date, label) and every request-local ref is the snapshot's own. The composition's
 * text of every planned field must be exactly those atoms, in the planned slots, framed by model wording; the wording is turned back into
 * shells and passes the shell gates again (`validateShellCandidate`, S1–S8) and then the assembler and the r7 verifier
 * (`composeAiResult`, S9–S10), which must reproduce the composition's text exactly. Only then is each phrased recorded-fact line rewritten
 * as `PhrasedLine.ai(bullets)`: the bullet(s) for its facts plus the deterministic parts the model never saw (time of day, duration).
 * Section intros and question bullets are validated but never stored: headings, group titles and patient questions stay as stored.
 *
 * The result is a new PREPARED, unapproved payload with the `AI_ASSISTED` composition and a new content hash; purpose, period, locale,
 * selection, values, questions, limitations, scope, notices and locale pack are the current snapshot's (`careSummaryAiReplacementIssues`
 * must be empty). The caller adds `replacesSnapshot`. Any failure is a closed refusal.
 *
 * Packet 11C Addendum C, Task C4: the payload is rendered by `renderAiAssistedCareSummary` (template and renderer 11c.2), which adds the
 * hashed AI marking (the approved rows ai.demoTag then ai.resultCheck) as the last section; `careSummaryAiMarkingIssues` must be empty.
 * The model-facing request is built from the current deterministic snapshot as before, so no request byte changes.
 */

export type CareSummaryAiProjectionCode = CareSummaryAiRequestRefusal | "COMPOSITION_INVALID" | "COMPOSITION_MISMATCH" | "SHELL_REJECTED" | "REPLACEMENT_INVALID";

export class CareSummaryAiProjectionError extends Error {
  readonly name = "CareSummaryAiProjectionError";
  constructor(readonly code: CareSummaryAiProjectionCode) {
    super(code);
  }
}
const refuse = (code: CareSummaryAiProjectionCode): never => {
  throw new CareSummaryAiProjectionError(code);
};

type FieldLike = { text: unknown; spans: unknown };
type SpanLike = { slotId: unknown; start: unknown; end: unknown };
/** Line feed, carriage return, line separator and paragraph separator: a stored line is never forged from model text. */
const LINE_BREAK_CODE_POINTS: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x2028, 0x2029]);
const hasLineBreak = (text: string) => [...text].some((char) => LINE_BREAK_CODE_POINTS.has(char.codePointAt(0)!));

/** The field's shell: its text with each planned atom span turned back into its token; refuses any other value or order. */
function shellOf(plan: SlotPlan, atoms: AtomTable, path: ShellFieldPath, field: FieldLike | undefined): string {
  if (!field || typeof field.text !== "string" || !Array.isArray(field.spans)) return refuse("COMPOSITION_MISMATCH");
  const text = field.text;
  if (hasLineBreak(text)) refuse("SHELL_REJECTED");
  const required = plan.fields.find((entry) => entry.path === path)?.requiredSlots ?? refuse("COMPOSITION_MISMATCH");
  const spans = field.spans as SpanLike[];
  if (spans.length !== required.length) refuse("COMPOSITION_MISMATCH");
  let shell = "";
  let cursor = 0;
  spans.forEach((span, index) => {
    const slotId = required[index]!;
    if (span.slotId !== slotId || typeof span.start !== "number" || typeof span.end !== "number" || span.start < cursor || span.end < span.start) refuse("COMPOSITION_MISMATCH");
    const start = span.start as number;
    const end = span.end as number;
    if (text.slice(start, end) !== atoms[slotId]?.text) refuse("COMPOSITION_MISMATCH");
    shell += `${text.slice(cursor, start)}${slotToken(slotId)}`;
    cursor = end;
  });
  return `${shell}${text.slice(cursor)}`;
}

export async function projectValidatedAiCareSummary(input: { current: CareSummarySnapshotPayload; composition: unknown; auditRef: string; validatedAt: Instant }): Promise<CareSummarySnapshotPayload> {
  const { current } = input;
  const built = buildCareSummaryAiRequest({ current, requestId: input.auditRef, requestedAt: input.validatedAt });
  if (built.kind !== "READY") return refuse(built.reason);
  const bundle = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
  const planned = planSlots(built.request, bundle);
  if (planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true) return refuse("COMPOSITION_INVALID");
  const { plan, atoms } = planned;

  // The composition: a care composition in the snapshot's locale with exactly the planned fields.
  const composition = input.composition as { taskType?: unknown; locale?: unknown; fields?: unknown } | null;
  if (typeof composition !== "object" || composition === null || composition.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY" || composition.locale !== current.locale || !(composition.fields instanceof Map)) {
    return refuse("COMPOSITION_INVALID");
  }
  const fields = composition.fields as ReadonlyMap<ShellFieldPath, FieldLike>;
  if (fields.size !== plan.fields.length) refuse("COMPOSITION_MISMATCH");
  const shells = new Map<ShellFieldPath, string>(plan.fields.map((field) => [field.path, shellOf(plan, atoms, field.path, fields.get(field.path))]));

  // S1–S8 again on the model wording, then S9–S10 (assembler and r7 verifier) with the snapshot's own atoms.
  const candidate = {
    schemaVersion: SHELL_OUTPUT_VERSIONS.DRAFT_CARE_PREPARATION_SUMMARY,
    slotPlanVersion: plan.planVersion,
    tokenInventory: remoteTokenInventory(plan),
    taskType: plan.taskType,
    locale: plan.locale,
    outcome: "SUCCESS",
    abstentionReason: null,
    shells: { sections: plan.sections.map((section) => ({ sectionSlot: section.sectionSlot, intro: shells.get(section.introPath)!, bullets: section.bulletPaths.map((path) => shells.get(path)!) })) },
  };
  const gated = validateShellCandidate(plan, bundle, candidate);
  if (gated.kind !== "VALID") return refuse("SHELL_REJECTED");
  const composed = composeAiResult(built.request, plan, atoms, gated.shells, bundle);
  if (composed.kind !== "ACCEPTED") return refuse("SHELL_REJECTED");
  for (const field of plan.fields) if (composed.composition.fields.get(field.path)?.text !== fields.get(field.path)!.text) refuse("COMPOSITION_MISMATCH");

  // Each fact's bullet text, by the local plan's own bindings (one bullet per fact; the appointment pair shares one).
  const bulletOf = new Map<string, string>();
  for (const slot of plan.slots) for (const ref of slot.boundRefs) bulletOf.set(ref, composed.composition.fields.get(slot.homeField)!.text);
  const sections = current.sections.map((section) => ({ ...section, blocks: [...section.blocks] as CareSummaryBlock[] }));
  for (const block of built.blocks) {
    const stored = sections[block.sectionIndex]!.blocks[block.blockIndex]!;
    if (stored.kind !== "RECORDED_FACT" || stored.blockId !== block.blockId) return refuse("REPLACEMENT_INVALID");
    const lines = block.lines.map((line) => {
      if (line.factRefs.length === 0) return line.deterministic;
      const bullets = [...new Set(line.factRefs.map((ref) => bulletOf.get(ref) ?? refuse("COMPOSITION_MISMATCH")))];
      return line.ai(bullets.join(" · "));
    });
    sections[block.sectionIndex]!.blocks[block.blockIndex] = { ...stored, renderedText: [...block.head, ...lines, ...block.tail].join("\n") };
  }

  // Packet 11C Addendum C, C4: renderer and template 11c.2 store the AI marking (the approved rows) after the notices and hash it.
  const rendered = await renderAiAssistedCareSummary({ current, sections: sections as CareSummarySnapshotPayload["sections"], aiInvocationAuditRef: input.auditRef, validatedAt: input.validatedAt });
  const parsed = careSummarySnapshotPayloadSchema.safeParse(rendered);
  if (!parsed.success) return refuse("REPLACEMENT_INVALID");
  const next = parsed.data as CareSummarySnapshotPayload;
  if (careSummaryAiReplacementIssues(current, next).length > 0 || careSummaryAiMarkingIssues(next).length > 0) return refuse("REPLACEMENT_INVALID");
  return next;
}
