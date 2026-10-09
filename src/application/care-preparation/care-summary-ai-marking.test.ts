import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AiLocale } from "@/domain/ai";
import {
  CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING,
  careSummaryExportProjection,
  careSummarySnapshotPayloadSchema,
  careSummarySnapshotRevisionSchema,
  type CareSummarySnapshotPayload,
} from "@/domain/care-preparation/care-summary-snapshot";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import { getMessages } from "@/i18n/get-messages";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { CARE_SUMMARY_AI_MARKING_BLOCK_ID, CARE_SUMMARY_AI_MARKING_ROWS, careSummaryAiMarkingIssues, careSummaryAiMarkingSection, careSummaryAiMarkingText } from "./care-summary-ai-marking";
import { printableCareSummary } from "./care-summary-artifact";
import { careSummarySnapshotRevisionCodec, storedCareSummarySnapshotRevisionSchema } from "./care-preparation-persistence";
import { projectValidatedAiCareSummary } from "./ai-care-summary-replacement";
import { CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION, CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION, CARE_SUMMARY_RENDERER_VERSION, CARE_SUMMARY_TEMPLATE_VERSION, isCurrentCareSummaryTemplate } from "./care-summary-locale-pack";
import { renderDeterministicCareSummary } from "./deterministic-care-summary-renderer";
import { acceptedAiCareComposition, AI_AUDIT_REF, AI_VALIDATED_AT, syntheticCareDraft } from "./care-preparation-test-support";

/**
 * Packet 11C Addendum C, Task C4: the AI marking of an AI-assisted care summary (renderer and template 11c.2). The renderer stores one
 * AI_MARKING block, built from the two approved catalogue rows (`ai.demoTag`, then `ai.resultCheck`) in the snapshot locale, in its own
 * last section after the notices, inside the hashed projection; it prints with the artifact and approval binds that exact artifact.
 * Deterministic snapshots carry none. Placement and appearance: human acceptance pending (only the two rows are approved copy).
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const deterministicOf = async (locale: AiLocale) => (await renderDeterministicCareSummary(syntheticCareDraft("RICH", locale))).payload;
async function aiAssistedOf(locale: AiLocale): Promise<CareSummarySnapshotPayload> {
  const current = await deterministicOf(locale);
  const { composition } = await acceptedAiCareComposition(current, { candidate: shellCandidate });
  return projectValidatedAiCareSummary({ current, composition, auditRef: AI_AUDIT_REF, validatedAt: AI_VALIDATED_AT });
}
const revision = (payload: CareSummarySnapshotPayload) => ({
  schemaVersion: 1,
  recordType: "CARE_SUMMARY_SNAPSHOT" as const,
  recordId: "00000000-0000-4000-8000-000000000050",
  revisionId: "00000000-0000-4000-8000-000000000051",
  revisionNumber: 1,
  previousRevisionId: null,
  action: "CREATE" as const,
  recordedAt: "2026-10-04T02:00:00.000Z",
  revisionCreatedAt: "2026-10-04T02:05:00.000Z",
  temporal: { kind: "ATEMPORAL" as const },
  provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: payload.composition.method === "AI_ASSISTED" ? "AI_ASSISTED" : "NONE" },
  auditEventId: "00000000-0000-4000-8000-000000000053",
  transactionId: "00000000-0000-4000-8000-000000000054",
  payload,
});
/** The stored-revision schema's issue messages (the codec's reasons, which its error does not carry). */
const storedIssues = (value: unknown) => {
  const result = storedCareSummarySnapshotRevisionSchema.safeParse(value);
  return result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.message))].sort();
};
/** The storage error a codec call throws, as plain fields (or "NO_ERROR"). */
function refusal(call: () => unknown) {
  try {
    call();
  } catch (error) {
    if (error instanceof StorageRowValidationError) return { name: error.name, code: error.code, table: error.table, boundary: error.boundary };
    throw error;
  }
  return "NO_ERROR";
}
/** The payload with its marking block's text replaced (and its hash recomputed, so only the marking differs). */
async function withMarkingText(payload: CareSummarySnapshotPayload, renderedText: string): Promise<CareSummarySnapshotPayload> {
  const sections = payload.sections.map((section) => (section.sectionId === "AI_MARKING" ? { ...section, blocks: section.blocks.map((block) => ({ ...block, renderedText })) } : section)) as CareSummarySnapshotPayload["sections"];
  const contentHash = await hashCanonicalJson(careSummaryExportProjection({ ...payload, sections, rendererVersion: payload.rendering.rendererVersion, localePackVersion: payload.rendering.localePackVersion }));
  return { ...payload, sections, rendering: { ...payload.rendering, contentHash } };
}

/** The exact hashed marking content (pinned; any change is a new renderer/template version). */
const MARKING = {
  "en-SG": {
    rows: ["AI-assisted demo", "Check the wording against your recorded information. AI can make mistakes."],
    renderedTextSha256: "119705928ff2eac844db81bbf2eaa45e9f2bbbe8cd6488f4bab686ad02aee297",
    blockCanonicalSha256: "a6d6e847efa4734cc02111707aa8c423835e372d5179977420723ccffc402f3a",
  },
  "zh-SG": {
    rows: ["AI 辅助演示", "请对照您已记录的资料检查内容。AI 可能会出错。"],
    renderedTextSha256: "f2efac82ab2cffd171954a26fcdd9fd716133e6ab99daf5631fbea60b090c5b1",
    blockCanonicalSha256: "85fab2ca055fed7e3388119c8bc81ae09fd5fc0eca010663f4b7c4da14e298ac",
  },
} as const;

describe("Packet 11C C4: the AI marking block", () => {
  it("names the versions: deterministic previews stay on 11c.1; AI-assisted snapshots use 11c.2", () => {
    expect([CARE_SUMMARY_TEMPLATE_VERSION, CARE_SUMMARY_RENDERER_VERSION]).toEqual(["care-summary-template.11c.1", "care-summary-renderer.11c.1"]);
    expect([CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION, CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION]).toEqual(["care-summary-template.11c.2", "care-summary-renderer.11c.2"]);
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: is built from the two approved rows in the locale, demoTag then resultCheck, and pinned by hash", async (locale) => {
    const ai = getMessages(locale).ai;
    const pinned = MARKING[locale];
    expect([ai.demoTag, ai.resultCheck]).toEqual(pinned.rows);
    const text = careSummaryAiMarkingText(locale);
    expect(text).toBe(`${ai.demoTag}\n${ai.resultCheck}`);
    const section = careSummaryAiMarkingSection(locale, 7);
    expect(section).toEqual({
      sectionId: "AI_MARKING",
      titleLocaleAssetId: "care-summary.section.ai-marking",
      displayOrder: 7,
      blocks: [{ kind: "AI_MARKING", blockId: CARE_SUMMARY_AI_MARKING_BLOCK_ID, temporalRole: "NOT_APPLICABLE", renderedText: text }],
    });
    expect(CARE_SUMMARY_AI_MARKING_BLOCK_ID).toBe("ai-marking");
    expect(sha256(text)).toBe(pinned.renderedTextSha256);
    expect(await hashCanonicalJson(section.blocks[0])).toBe(pinned.blockCanonicalSha256);
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: the AI-assisted snapshot carries exactly the marking, last, inside the hashed projection", async (locale) => {
    const current = await deterministicOf(locale);
    const next = await aiAssistedOf(locale);
    expect(next.composition).toMatchObject({ method: "AI_ASSISTED", templateVersion: "care-summary-template.11c.2" });
    expect(next.rendering).toMatchObject({ rendererVersion: "care-summary-renderer.11c.2", localePackVersion: current.rendering.localePackVersion });
    expect(next.sections.map((section) => section.sectionId)).toEqual([...current.sections.map((section) => section.sectionId), "AI_MARKING"]);
    expect(next.sections.at(-1)).toEqual(careSummaryAiMarkingSection(locale, current.sections.length));
    expect(careSummaryAiMarkingIssues(next)).toEqual([]);
    expect(isCurrentCareSummaryTemplate(next)).toBe(true);
    // The content hash covers the marking and the 11c.2 renderer: without it, or with other rows, the hash differs.
    const hashOf = (value: CareSummarySnapshotPayload, sections = value.sections) => hashCanonicalJson(careSummaryExportProjection({ ...value, sections, rendererVersion: value.rendering.rendererVersion, localePackVersion: value.rendering.localePackVersion }));
    expect(await hashOf(next)).toBe(next.rendering.contentHash);
    expect(await hashOf(next, next.sections.slice(0, -1) as CareSummarySnapshotPayload["sections"])).not.toBe(next.rendering.contentHash);
    // The deterministic preview it replaces carries no marking and no AI label.
    expect(current.sections.some((section) => section.sectionId === "AI_MARKING")).toBe(false);
    expect(careSummaryAiMarkingIssues(current)).toEqual([]);
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: prints the marking with the artifact (its rows, after the notices); a deterministic artifact prints none", async (locale) => {
    const ai = getMessages(locale).ai;
    const next = await aiAssistedOf(locale);
    const printed = printableCareSummary(next);
    expect(printed.lines.slice(-2)).toEqual([
      { kind: "HEADING", text: ai.demoTag },
      { kind: "TEXT", text: ai.resultCheck },
    ]);
    expect(printed.text.endsWith(`\n## ${ai.demoTag}\n${ai.resultCheck}`)).toBe(true);
    const deterministic = printableCareSummary(await deterministicOf(locale));
    expect(deterministic.text).not.toContain(ai.demoTag);
    expect(deterministic.text).not.toContain(ai.resultCheck);
    expect(deterministic.lines.some((line) => line.text === ai.demoTag)).toBe(false);
  });

  it("rejects an 11c.2 AI-assisted snapshot without the exact block: other wording, the other locale's rows, a missing or reordered row", async () => {
    const next = await aiAssistedOf("en-SG");
    const en = getMessages("en-SG").ai;
    const zh = getMessages("zh-SG").ai;
    for (const text of [`${zh.demoTag}\n${zh.resultCheck}`, `${en.resultCheck}\n${en.demoTag}`, `${en.demoTag}\nAI-generated. Check it.`, `${en.demoTag} \n${en.resultCheck}`]) {
      const tampered = await withMarkingText(next, text);
      // Structurally valid (two rows), so only the exact-row validator refuses it.
      expect(careSummarySnapshotPayloadSchema.safeParse(tampered).success).toBe(true);
      expect(careSummaryAiMarkingIssues(tampered)).toEqual(["SUMMARY_AI_MARKING_INVALID"]);
    }
    const without = { ...next, sections: next.sections.slice(0, -1) } as CareSummarySnapshotPayload;
    expect(careSummaryAiMarkingIssues(without)).toEqual(["SUMMARY_AI_MARKING_INVALID"]);
    const retitled = { ...next, sections: next.sections.map((section) => (section.sectionId === "AI_MARKING" ? { ...section, titleLocaleAssetId: "care-summary.section.notes" } : section)) } as CareSummarySnapshotPayload;
    expect(careSummaryAiMarkingIssues(retitled)).toEqual(["SUMMARY_AI_MARKING_INVALID"]);
  });

  it("the stored-revision codec (storage, backup and restore row validation) refuses a snapshot without the exact block and keeps the exact one", async () => {
    const next = await aiAssistedOf("zh-SG");
    const row = careSummarySnapshotRevisionCodec.create(revision(next) as never);
    expect(JSON.stringify(careSummarySnapshotRevisionCodec.validateAfterRead(JSON.parse(JSON.stringify(row))).revision.payload)).toBe(JSON.stringify(next));
    // C4 fix round 1 (review Minor 2): each refusal is the storage boundary's own error, caused by exactly the marking issue.
    const tampered = await withMarkingText(next, careSummaryAiMarkingText("en-SG"));
    // The domain accepts it (two rows, right place); only the exact-marking rule refuses it.
    expect(careSummarySnapshotRevisionSchema.safeParse(revision(tampered)).success).toBe(true);
    expect(storedIssues(revision(tampered))).toEqual(["SUMMARY_AI_MARKING_INVALID"]);
    expect(refusal(() => careSummarySnapshotRevisionCodec.create(revision(tampered) as never))).toEqual({ name: "StorageRowValidationError", code: "STORAGE_VALIDATION_FAILED", table: "recordRevisions", boundary: "WRITE" });
    const raw = JSON.parse(JSON.stringify(row)) as { revision: { payload: CareSummarySnapshotPayload } };
    raw.revision.payload = tampered;
    expect(refusal(() => careSummarySnapshotRevisionCodec.validateAfterRead(raw))).toEqual({ name: "StorageRowValidationError", code: "STORAGE_INTEGRITY_FAILED", table: "recordRevisions", boundary: "READ" });
    // A deterministic snapshot with the marking is refused as well (by the domain structure rule and the exact rule).
    const deterministic = await deterministicOf("zh-SG");
    const marked = { ...deterministic, sections: [...deterministic.sections, careSummaryAiMarkingSection("zh-SG", deterministic.sections.length)] } as CareSummarySnapshotPayload;
    expect(storedIssues(revision(marked))).toEqual(["SUMMARY_AI_MARKING_INVALID"]);
    expect(refusal(() => careSummarySnapshotRevisionCodec.create(revision(marked) as never))).toEqual({ name: "StorageRowValidationError", code: "STORAGE_VALIDATION_FAILED", table: "recordRevisions", boundary: "WRITE" });
  });

  it("C4 fix round 1 (review Minor 1): validates against the rows frozen with template 11c.2, which equal the approved catalogue rows today", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const ai = getMessages(locale).ai;
      expect(CARE_SUMMARY_AI_MARKING_ROWS["care-summary-template.11c.2"]![locale]).toEqual({ demoTag: ai.demoTag, resultCheck: ai.resultCheck });
      expect(careSummaryAiMarkingText(locale, "care-summary-template.11c.2")).toBe(`${MARKING[locale].rows[0]}\n${MARKING[locale].rows[1]}`);
    }
    // Every AI-marking template version has frozen rows for both locales; any other version has none.
    expect(Object.keys(CARE_SUMMARY_AI_MARKING_ROWS)).toEqual([...CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING]);
    expect(Object.isFrozen(CARE_SUMMARY_AI_MARKING_ROWS) && Object.isFrozen(CARE_SUMMARY_AI_MARKING_ROWS["care-summary-template.11c.2"])).toBe(true);
    expect(() => careSummaryAiMarkingText("en-SG", "care-summary-template.11c.1")).toThrow("SUMMARY_AI_MARKING_INVALID");
  });
});
