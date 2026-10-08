import type { Instant, RecordType } from "@/domain/shared";
import type { TimePoint } from "@/domain/shared/temporal";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { CareSummaryBlock, CareSummaryFactBinding, CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { AI_ORGANISABLE_SECTIONS, aiTaskRequestSchema, type AiRequestFact, type AiTaskRequestFor } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { redactSelectedText } from "@/application/ai/detached-payload-projector";
import { CARE_SUMMARY_LOCALE_PACK_VERSION, careSummaryLocalePack, isCurrentCareSummaryTemplate, type CareSummaryLocalePack } from "./care-summary-locale-pack";

/**
 * Packet 11C Addendum B, Task B1b: the source-closed `DRAFT_CARE_PREPARATION_SUMMARY` request for one CURRENT unapproved deterministic
 * snapshot, built from the snapshot alone (no source record is read). Only the AI-organisable sections take part, and within them only
 * recorded-fact lines whose stored text this module reconstructs exactly from the block's own bindings (current renderer layout), plus
 * the patient questions. The scope, limitations, safety history and care-draft notices never enter the request.
 *
 * Fact kinds are exactly those of the evaluated care fixtures (packet11-fixtures, care classes), so the model-facing body is a known
 * care body class: a glucose value (MEASUREMENT_VALUE / DECIMAL mmol/L), an appointment (APPOINTMENT_SERVICE label followed by its
 * APPOINTMENT_TIME local date, one bullet), a meal item or a walk (INTAKE_LABEL / ACTIVITY_LABEL text, one bullet each) and a patient
 * question (QUESTION_TEXT). Times of day, durations, medication records and coded meal kinds are never sent; they stay in their
 * deterministic wording around the AI wording (see `PhrasedLine`). Each fact names its exact snapshot sources as local provenance
 * (stripped by the detached projector before planning; recorded in the AI audit only if a call is made).
 *
 * Fail closed (`NOT_ELIGIBLE`, no request): a snapshot that is not the current deterministic template, not PREPARED/PREVIEWED, has a
 * recognised block whose stored text does not reconstruct, has nothing to phrase, more than 32 facts or 8 sections, or patient text
 * that the detached projector would redact (the AI wording would then show a changed label).
 */

type Ref = TypedRevisionRef<RecordType>;

/** One stored line of a recorded-fact block, and how its AI-assisted wording is assembled around the bullet(s) for its facts. */
export type PhrasedLine = Readonly<{
  /** The exact deterministic line (part of the stored renderedText). */
  deterministic: string;
  /** The request-local fact refs whose bullets replace this line's phrased value; empty: the line stays deterministic. */
  factRefs: readonly string[];
  /** The AI-assisted line: the deterministic parts the model never saw (time of day, duration), joined with the bullet text. */
  ai(bullets: string): string;
}>;

/** One recorded-fact block of an AI-organisable section whose stored text this module reconstructs exactly. */
export type PhrasedBlock = Readonly<{ sectionIndex: number; blockIndex: number; blockId: string; head: readonly string[]; lines: readonly PhrasedLine[]; tail: readonly string[] }>;

export type CareSummaryAiRequestRefusal = "NOT_CURRENT_DETERMINISTIC" | "LAYOUT_UNRECOGNISED" | "NOTHING_TO_PHRASE" | "TOO_MANY_FACTS" | "TEXT_NOT_SENDABLE";

export type CareSummaryAiRequest =
  | Readonly<{ kind: "READY"; request: AiTaskRequestFor<"DRAFT_CARE_PREPARATION_SUMMARY">; blocks: readonly PhrasedBlock[] }>
  | Readonly<{ kind: "NOT_ELIGIBLE"; reason: CareSummaryAiRequestRefusal }>;

const SEPARATOR = " · ";
const MAX_FACTS = 32;
const MAX_SECTIONS = 8;

class NotEligible extends Error {
  constructor(readonly reason: CareSummaryAiRequestRefusal) {
    super(reason);
  }
}
const refuse = (reason: CareSummaryAiRequestRefusal): never => {
  throw new NotEligible(reason);
};

const plain = (ref: Ref): Ref => ({ recordType: ref.recordType, recordId: ref.recordId, revisionId: ref.revisionId });

/** The local calendar date of a time point in its own time zone (Singapore when none is recorded), or null when unknown. */
function localDateOf(point: TimePoint): string | null {
  if (point.kind === "UNKNOWN") return null;
  if (point.kind === "DATE_ONLY") return point.localDate;
  const instant = new Date(point.kind === "EXACT" ? point.instantUtc : point.approximateInstantUtc);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: point.timeZoneId ?? "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The bindings of one block grouped by their line index (`<blockId>.<n>.<suffix>`), in stored order. */
function bindingLines(block: Extract<CareSummaryBlock, { kind: "RECORDED_FACT" }>): Map<string, Map<string, CareSummaryFactBinding>> {
  const lines = new Map<string, Map<string, CareSummaryFactBinding>>();
  for (const binding of block.factBindings) {
    const rest = binding.bindingKey.startsWith(`${block.blockId}.`) ? binding.bindingKey.slice(block.blockId.length + 1) : refuse("LAYOUT_UNRECOGNISED");
    const dot = rest.indexOf(".");
    if (dot <= 0) refuse("LAYOUT_UNRECOGNISED");
    const line = rest.slice(0, dot);
    const suffix = rest.slice(dot + 1);
    if (!lines.has(line)) lines.set(line, new Map());
    if (lines.get(line)!.has(suffix)) refuse("LAYOUT_UNRECOGNISED");
    lines.get(line)!.set(suffix, binding);
  }
  return lines;
}

type FactSink = (fact: Omit<AiRequestFact, "ref">) => string;

const exactKeys = (line: Map<string, CareSummaryFactBinding>, keys: readonly string[]) => line.size === keys.length && keys.every((key) => line.has(key));

/** Reconstructs one recognised block exactly (or refuses), registering a fact for every phrased value. Null: not a phrasable block. */
function phraseBlock(block: Extract<CareSummaryBlock, { kind: "RECORDED_FACT" }>, pack: CareSummaryLocalePack, addFact: FactSink): { head: string[]; lines: PhrasedLine[]; tail: string[] } | null {
  const point = (binding: CareSummaryFactBinding | undefined, field: string): TimePoint => (binding?.kind === "TIME_POINT" && binding.sourceField === field ? binding.value : refuse("LAYOUT_UNRECOGNISED"));
  const text = (binding: CareSummaryFactBinding | undefined, field: string): { text: string; language: "en-SG" | "zh-SG" | "und"; source: Ref } =>
    binding?.kind === "PATIENT_TEXT" && binding.sourceField === field ? { text: binding.text, language: binding.language, source: plain(binding.source) } : refuse("LAYOUT_UNRECOGNISED");
  const sendable = (value: string) => (redactSelectedText(value) === value ? value : refuse("TEXT_NOT_SENDABLE"));

  if (block.blockId === "organisation.appointment") {
    const label = block.factBindings.find((binding) => binding.bindingKey === "organisation.appointment.label");
    const time = block.factBindings.find((binding) => binding.bindingKey === "organisation.appointment.time");
    if (block.factBindings.length !== 2) refuse("LAYOUT_UNRECOGNISED");
    const service = text(label, "PATIENT_AUTHORED_TEXT");
    const at = point(time, "APPOINTMENT_TIME");
    const localDate = localDateOf(at) ?? refuse("LAYOUT_UNRECOGNISED");
    const refs = [
      addFact({ field: "APPOINTMENT_SERVICE", value: { kind: "TEXT", text: sendable(service.text), language: service.language }, sources: [service.source] }),
      addFact({ field: "APPOINTMENT_TIME", value: { kind: "DATE", localDate } as AiRequestFact["value"], sources: [plain(time!.source)] }),
    ];
    const timeOfDay = pack.pointParts(at).time ?? pack.summary.timeNotRecorded;
    return {
      head: [],
      lines: [{ deterministic: `${service.text}${SEPARATOR}${pack.pointText(at)}`, factRefs: refs, ai: (bullets) => [bullets, timeOfDay].join(SEPARATOR) }],
      tail: [`${pack.appointmentEnteredByYou}${SEPARATOR}${pack.appointmentUnverified}`],
    };
  }

  const group = ({ "measurements.glucose": "GLUCOSE", "intake.meals": "MEALS", "activity.walks": "WALKS" } as const)[block.blockId as "measurements.glucose" | "intake.meals" | "activity.walks"];
  if (group === undefined) return null; // e.g. medication.insulin: stays exactly as stored, never sent.
  const lines: PhrasedLine[] = [];
  for (const [index, line] of bindingLines(block)) {
    if (!/^[1-9]\d*$/.test(index)) refuse("LAYOUT_UNRECOGNISED");
    const when = pack.pointText(point(line.get("time"), "OCCURRENCE_TIME"));
    if (group === "GLUCOSE") {
      const value = line.get("value");
      if (!exactKeys(line, ["value", "time"]) || value?.kind !== "DECIMAL_VALUE" || value.sourceField !== "MEASUREMENT_VALUE" || value.unit.kind !== "STANDARD" || value.unit.code !== "MMOL_L") refuse("LAYOUT_UNRECOGNISED");
      const decimal = value as Extract<CareSummaryFactBinding, { kind: "DECIMAL_VALUE" }>;
      const ref = addFact({ field: "MEASUREMENT_VALUE", value: { kind: "DECIMAL", value: decimal.value, unit: "MMOL_L" }, sources: [plain(decimal.source)] });
      lines.push({ deterministic: `${when}${SEPARATOR}${decimal.value} ${pack.glucoseUnit}`, factRefs: [ref], ai: (bullets) => `${when}${SEPARATOR}${bullets}` });
    } else if (group === "MEALS") {
      const itemKeys = [...line.keys()].filter((key) => key.startsWith("item."));
      if (itemKeys.length === 0) {
        // A meal recorded without items keeps its approved wording; nothing about it is sent.
        const kind = line.get("kind");
        if (!exactKeys(line, ["time", "kind"]) || kind?.kind !== "CODED_VALUE" || kind.sourceField !== "INTAKE_KIND") refuse("LAYOUT_UNRECOGNISED");
        lines.push({ deterministic: `${when}${SEPARATOR}${pack.schedule.intakeRecord}`, factRefs: [], ai: () => refuse("LAYOUT_UNRECOGNISED") });
        continue;
      }
      const expectedItems = itemKeys.map((_, item) => `item.${item + 1}`);
      if (!exactKeys(line, ["time", ...expectedItems])) refuse("LAYOUT_UNRECOGNISED");
      const items = expectedItems.map((key) => text(line.get(key), "INTAKE_LABEL"));
      const refs = items.map((item) => addFact({ field: "INTAKE_LABEL", value: { kind: "TEXT", text: sendable(item.text), language: "und" }, sources: [item.source] }));
      lines.push({ deterministic: `${when}${SEPARATOR}${items.map((item) => item.text).join(", ")}`, factRefs: refs, ai: (bullets) => `${when}${SEPARATOR}${bullets}` });
    } else {
      const minutes = line.get("minutes");
      if (!exactKeys(line, minutes ? ["time", "label", "minutes"] : ["time", "label"])) refuse("LAYOUT_UNRECOGNISED");
      if (minutes && (minutes.kind !== "WHOLE_COUNT" || minutes.sourceField !== "ACTIVITY_DURATION")) refuse("LAYOUT_UNRECOGNISED");
      const label = text(line.get("label"), "ACTIVITY_LABEL");
      const duration = minutes?.kind === "WHOLE_COUNT" ? [pack.minutes(minutes.value)] : [];
      const ref = addFact({ field: "ACTIVITY_LABEL", value: { kind: "TEXT", text: sendable(label.text), language: "und" }, sources: [label.source] });
      lines.push({ deterministic: [when, label.text, ...duration].join(SEPARATOR), factRefs: [ref], ai: (bullets) => [when, bullets, ...duration].join(SEPARATOR) });
    }
  }
  return { head: [pack.groupTitles[group]], lines, tail: [] };
}

export function buildCareSummaryAiRequest(input: { current: CareSummarySnapshotPayload; requestId: string; requestedAt: Instant }): CareSummaryAiRequest {
  const current = input.current;
  try {
    if (
      current.composition.method !== "DETERMINISTIC" ||
      !isCurrentCareSummaryTemplate(current) ||
      current.rendering.localePackVersion !== CARE_SUMMARY_LOCALE_PACK_VERSION ||
      (current.status !== "PREPARED" && current.status !== "PREVIEWED") ||
      current.patientApproval.state !== "NOT_APPROVED"
    ) {
      return refuse("NOT_CURRENT_DETERMINISTIC");
    }
    const pack = careSummaryLocalePack(current.locale);
    const facts: AiRequestFact[] = [];
    const addFact: FactSink = (fact) => {
      const ref = `fact-${facts.length + 1}`;
      if (facts.length >= MAX_FACTS) refuse("TOO_MANY_FACTS");
      facts.push({ ref, ...fact } as AiRequestFact);
      return ref;
    };
    const sections: Array<{ ref: string; sectionId: string; factRefs: string[] }> = [];
    const blocks: PhrasedBlock[] = [];
    current.sections.forEach((section, sectionIndex) => {
      if (!(AI_ORGANISABLE_SECTIONS as readonly string[]).includes(section.sectionId)) return;
      const factRefs: string[] = [];
      section.blocks.forEach((block, blockIndex) => {
        if (block.kind === "PATIENT_QUESTION") {
          // The question is sent so the draft is organised as evaluated; its stored block never changes (verbatim patient words).
          factRefs.push(addFact({ field: "QUESTION_TEXT", value: { kind: "TEXT", text: block.originalPatientText.text, language: block.originalPatientText.language }, sources: [plain(block.question)] }));
          if (redactSelectedText(block.originalPatientText.text) !== block.originalPatientText.text) refuse("TEXT_NOT_SENDABLE");
          return;
        }
        if (block.kind !== "RECORDED_FACT") return;
        const phrased = phraseBlock(block, pack, addFact);
        if (phrased === null) return;
        if ([...phrased.head, ...phrased.lines.map((line) => line.deterministic), ...phrased.tail].join("\n") !== block.renderedText) refuse("LAYOUT_UNRECOGNISED");
        blocks.push(Object.freeze({ sectionIndex, blockIndex, blockId: block.blockId, head: Object.freeze(phrased.head), lines: Object.freeze(phrased.lines.map((line) => Object.freeze(line))), tail: Object.freeze(phrased.tail) }));
        for (const line of phrased.lines) factRefs.push(...line.factRefs);
      });
      if (factRefs.length > 0) sections.push({ ref: `section-${sections.length + 1}`, sectionId: section.sectionId, factRefs });
    });
    if (!blocks.some((block) => block.lines.some((line) => line.factRefs.length > 0))) refuse("NOTHING_TO_PHRASE");
    if (sections.length > MAX_SECTIONS) refuse("TOO_MANY_FACTS");
    const request = {
      requestId: input.requestId,
      requestedAt: input.requestedAt,
      releaseProfile: "HACKATHON_DEMO" as const,
      taskType: "DRAFT_CARE_PREPARATION_SUMMARY" as const,
      locale: current.locale,
      runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey,
      facts,
      taskPayload: { sections },
    };
    // The request is exactly the internal contract, or nothing.
    if (!aiTaskRequestSchema.safeParse(request).success) refuse("LAYOUT_UNRECOGNISED");
    return Object.freeze({ kind: "READY", request: request as AiTaskRequestFor<"DRAFT_CARE_PREPARATION_SUMMARY">, blocks: Object.freeze(blocks) });
  } catch (error) {
    if (error instanceof NotEligible) return Object.freeze({ kind: "NOT_ELIGIBLE", reason: error.reason });
    throw error;
  }
}
