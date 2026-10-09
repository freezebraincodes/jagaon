import { describe, expect, it } from "vitest";
import type { AiLocale, ShellFieldPath } from "@/domain/ai";
import { careSummaryAiReplacementIssues, careSummaryExportProjection, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import type { AiComposition } from "@/application/ai/language/assembler";
import { CareSummaryAiProjectionError, projectValidatedAiCareSummary } from "./ai-care-summary-replacement";
import { printableCareSummary } from "./care-summary-artifact";
import { careSummaryAiMarkingSection } from "./care-summary-ai-marking";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { acceptedAiCareComposition, AI_AUDIT_REF as AUDIT_REF, AI_VALIDATED_AT as VALIDATED_AT, asLegacy9c1Payload, NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "./care-preparation-test-support";
import { renderDeterministicCareSummary } from "./deterministic-care-summary-renderer";

/**
 * Packet 11C Addendum B, Task B1b (original Task 1 Step 4): `projectValidatedAiCareSummary` rebuilds the request from the current
 * snapshot, re-plans it, re-validates the composition's wording through the shell gates (S1–S8) and the assembler and r7 verifier
 * (S9–S10) against the snapshot's own atoms, and only then rewrites the rendered text of the phrased recorded-fact lines. Values, ids,
 * questions, limitations, scope and notices come from the current snapshot, never from the composition. Fake provider only.
 */

const acceptedAiComposition = (current: CareSummarySnapshotPayload) => acceptedAiCareComposition(current, { candidate: shellCandidate });
const snapshotOf = async (shape: SyntheticCareDraftShape, locale: AiLocale) => (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
const project = (current: CareSummarySnapshotPayload, composition: unknown) => projectValidatedAiCareSummary({ current, composition, auditRef: AUDIT_REF, validatedAt: VALIDATED_AT as never });
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CareSummaryAiProjectionError) return error.code;
    throw error;
  }
  return "PROJECTED";
};
const blockText = (payload: CareSummarySnapshotPayload, blockId: string) => {
  for (const section of payload.sections) for (const block of section.blocks) if (block.blockId === blockId && "renderedText" in block) return block.renderedText;
  throw new Error(blockId);
};
/** A composition whose one field text gets `prefix` in front, its atom spans shifted to stay internally consistent. */
function withPrefix(composition: AiComposition, path: ShellFieldPath, prefix: string): AiComposition {
  const fields = new Map(composition.fields);
  const field = fields.get(path)!;
  fields.set(path, { text: `${prefix}${field.text}`, spans: field.spans.map((span) => ({ ...span, start: span.start + prefix.length, end: span.end + prefix.length })), segments: [`${prefix}${field.segments[0]}`, ...field.segments.slice(1)] });
  return { ...composition, fields };
}

describe("projectValidatedAiCareSummary (Packet 11C B1b)", () => {
  it.each(["en-SG", "zh-SG"] as const)("%s: rewrites only the phrased recorded-fact lines; everything else is the current snapshot's", async (locale) => {
    const current = await snapshotOf("RICH", locale);
    const { composition } = await acceptedAiComposition(current);
    const next = await project(current, composition);

    // Packet 11C Addendum C, C4 (deliberate): the replacement is made under template and renderer 11c.2 and carries the AI marking.
    expect(next.composition).toEqual({ method: "AI_ASSISTED", templateVersion: "care-summary-template.11c.2", aiInvocationAuditRef: AUDIT_REF, validatedAt: VALIDATED_AT });
    expect(next.status).toBe("PREPARED");
    expect(next.patientApproval).toEqual({ state: "NOT_APPROVED" });
    expect(next.replacesSnapshot).toBeUndefined();
    expect(careSummaryAiReplacementIssues(current, next)).toEqual([]);
    // New content hash, exactly the hash of the new export projection.
    const hash = await hashCanonicalJson(careSummaryExportProjection({ ...next, rendererVersion: next.rendering.rendererVersion, localePackVersion: next.rendering.localePackVersion }));
    expect(next.rendering).toEqual({ ...current.rendering, rendererVersion: "care-summary-renderer.11c.2", contentHash: hash });
    expect(hash).not.toBe(current.rendering.contentHash);
    expect(next.sections.slice(0, -1).map((section) => section.sectionId)).toEqual(current.sections.map((section) => section.sectionId));
    expect(next.sections.at(-1)).toEqual(careSummaryAiMarkingSection(locale, current.sections.length));

    // Insulin, scope, questions, limitations and notices: byte-identical blocks.
    for (const sectionId of ["SUMMARY_SCOPE", "MEDICATION_RECORDS", "QUESTIONS_FOR_CARE_TEAM", "DATA_LIMITATIONS", "CARE_DRAFT_NOTICES"]) {
      expect(JSON.stringify(next.sections.find((section) => section.sectionId === sectionId))).toBe(JSON.stringify(current.sections.find((section) => section.sectionId === sectionId)));
    }
    // Every phrased line keeps the deterministic parts the model never saw, in place; the values are the snapshot's own.
    const lines = (blockId: string) => blockText(next, blockId).split("\n");
    const before = (blockId: string) => blockText(current, blockId).split("\n");
    // The assembler's own zh spacing puts a space between an ideograph and a Latin or digit atom.
    const recorded = (atom: string) => (locale === "en-SG" ? `You recorded ${atom}.` : /^[A-Za-z0-9]/.test(atom) ? `您记录了 ${atom}。` : `您记录了${atom}。`);
    const [title, first, second] = before("measurements.glucose");
    expect(lines("measurements.glucose")).toEqual([title, first!.replace(/ · (.+)$/, (_, value: string) => ` · ${recorded(value)}`), second!.replace(/ · (.+)$/, (_, value: string) => ` · ${recorded(value)}`)]);
    const [appointmentLine, enteredByYou] = before("organisation.appointment");
    const [service, when] = appointmentLine!.split(" · ");
    const [date, time] = locale === "en-SG" ? when!.split(", ") : when!.split(" ");
    expect(lines("organisation.appointment")).toEqual([`${recorded(locale === "en-SG" ? `${service}, ${date}` : `${service}，${date}`)} · ${time}`, enteredByYou]);
    const meals = before("intake.meals");
    expect(lines("intake.meals")).toEqual([meals[0], meals[1]!.replace(/ · (.+)$/, (_, item: string) => ` · ${recorded(item)}`), meals[2]]);
    const [walkTitle, walk] = before("activity.walks");
    const [walkWhen, walkLabel, minutes] = walk!.split(" · ");
    expect(lines("activity.walks")).toEqual([walkTitle, [walkWhen, recorded(walkLabel!), minutes].join(" · ")]);
    // The printable artifact is generated from the new blocks as usual.
    expect(printableCareSummary(next).text).toContain(recorded(walkLabel!));
  });

  it("is deterministic: the same snapshot and composition give byte-identical payloads", async () => {
    const current = await snapshotOf("HIDDEN_LIMITATION", "en-SG");
    const { composition } = await acceptedAiComposition(current);
    expect(JSON.stringify(await project(current, composition))).toBe(JSON.stringify(await project(structuredClone(current), composition)));
  });

  it("never trusts a value, an id or wording that the gates would refuse", async () => {
    const current = await snapshotOf("RICH", "en-SG");
    const { composition } = await acceptedAiComposition(current);
    const glucoseBullet = "sections[1].bullets[0]" as ShellFieldPath;
    // A changed value inside the assembled text.
    const changed = new Map(composition.fields);
    const field = changed.get(glucoseBullet)!;
    changed.set(glucoseBullet, { ...field, text: field.text.replace("6.1", "9.9") });
    expect(await refusal(project(current, { ...composition, fields: changed }))).toBe("COMPOSITION_MISMATCH");
    // Two bullets swapped (each value lands on the other fact).
    const swapped = new Map(composition.fields);
    swapped.set(glucoseBullet, composition.fields.get("sections[1].bullets[1]" as ShellFieldPath)!);
    swapped.set("sections[1].bullets[1]" as ShellFieldPath, composition.fields.get(glucoseBullet)!);
    expect(await refusal(project(current, { ...composition, fields: swapped }))).toBe("COMPOSITION_MISMATCH");
    // A composition of another snapshot (other values) or another locale; a missing field; not a composition at all.
    const other = await snapshotOf("RICH", "zh-SG");
    expect(await refusal(project(current, (await acceptedAiComposition(other)).composition))).toBe("COMPOSITION_INVALID");
    const missing = new Map(composition.fields);
    missing.delete(glucoseBullet);
    expect(await refusal(project(current, { ...composition, fields: missing }))).toBe("COMPOSITION_MISMATCH");
    expect(await refusal(project(current, { taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "en-SG" }))).toBe("COMPOSITION_INVALID");
    expect(await refusal(project(current, null))).toBe("COMPOSITION_INVALID");
    // Wording the shell gates refuse (a directive), and a line break that would forge a line, even with consistent spans.
    expect(await refusal(project(current, withPrefix(composition, glucoseBullet, "You should check: ")))).toBe("SHELL_REJECTED");
    expect(await refusal(project(current, withPrefix(composition, glucoseBullet, "Noted\nentry: ")))).toBe("SHELL_REJECTED");
    // The intro wording is checked too, although it is not stored.
    expect(await refusal(project(current, withPrefix(composition, "sections[1].intro" as ShellFieldPath, "Your diabetes notes. ")))).toBe("SHELL_REJECTED");
  });

  it("projects only from the current unapproved deterministic snapshot", async () => {
    const current = await snapshotOf("ORDINARY", "en-SG");
    const { composition } = await acceptedAiComposition(current);
    expect(await refusal(project(await asLegacy9c1Payload(current), composition))).toBe("NOT_CURRENT_DETERMINISTIC");
    expect(await refusal(project({ ...current, status: "APPROVED", patientApproval: { state: "APPROVED", approvedAt: NOW, approvedContentHash: current.rendering.contentHash } }, composition))).toBe("NOT_CURRENT_DETERMINISTIC");
    const projected = await project(current, composition);
    expect(await refusal(project(projected, composition))).toBe("NOT_CURRENT_DETERMINISTIC");
    expect(await refusal(project(current, composition))).toBe("PROJECTED");
  });
});
