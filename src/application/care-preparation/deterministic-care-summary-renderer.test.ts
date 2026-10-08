import { describe, expect, it } from "vitest";
import type { Instant } from "@/domain/shared";
import { CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES, careSummaryExportProjection, careSummarySnapshotPayloadSchema, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { careDraftNoticesFor } from "@/application/ai/language/care-draft-notices";
import { renderDeterministicCareSummary, type CareSummaryDraft } from "./deterministic-care-summary-renderer";
import { CARE_SUMMARY_LOCALE_PACK_VERSION, CARE_SUMMARY_RENDERER_VERSION, CARE_SUMMARY_TEMPLATE_VERSION } from "./care-summary-locale-pack";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as never;
const ref = <T extends string>(recordType: T, n: number) => ({ recordType, recordId: id(n), revisionId: id(n + 500) }) as never;
const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });

function draft(locale: "en-SG" | "zh-SG" = "en-SG"): CareSummaryDraft {
  return {
    locale,
    asOf: "2026-10-04T02:00:00.000Z" as Instant,
    period: { startAt: "2026-09-04T16:00:00.000Z" as Instant, endAtExclusive: "2026-10-04T16:00:00.000Z" as Instant, startDate: "2026-09-05", endDate: "2026-10-04" },
    appointment: { ref: ref("APPOINTMENT", 1), label: "Dr Lim, Bukit Merah Polyclinic", scheduledAt: exact("2026-10-14T01:40:00.000Z") },
    groups: [
      {
        key: "GLUCOSE",
        facts: [
          { kind: "GLUCOSE", ref: ref("GLUCOSE_READING", 3), occurrence: exact("2026-10-03T13:00:00.000Z"), value: "6.60" },
          { kind: "GLUCOSE", ref: ref("GLUCOSE_READING", 2), occurrence: exact("2026-10-02T23:30:00.000Z"), value: "11.2" },
        ],
      },
      {
        key: "INSULIN",
        facts: [
          {
            kind: "MEDICATION_EVENT",
            ref: ref("MEDICATION_EVENT", 4),
            occurrence: { kind: "UNKNOWN" },
            state: "MISSED",
            intendedAt: exact("2026-09-30T13:00:00.000Z"),
            amount: null,
            medication: { ref: ref("MEDICATION", 5), name: "Nocturin pen (demo)" },
          },
        ],
      },
      { key: "WALKS", facts: [{ kind: "ACTIVITY", ref: ref("ACTIVITY_EVENT", 6), occurrence: exact("2026-10-01T00:30:00.000Z"), label: "Bishan Park 公园", minutes: 25 }] },
    ],
    questions: [{ ref: ref("CARE_QUESTION", 7), text: "可以把笔放在包里吗？", language: "zh-SG" }],
    excluded: [{ source: ref("INTAKE_EVENT", 8), reason: "NOT_SELECTED" }],
  };
}

describe("deterministic care-summary renderer", () => {
  it("renders only the selected facts, in fixed section order, with exact values and the scope block", async () => {
    const prepared = await renderDeterministicCareSummary(draft());
    const payload = prepared.payload;
    expect(careSummarySnapshotPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.sections.map((section) => section.sectionId)).toEqual(["SUMMARY_SCOPE", "CARE_ORGANISATION", "MEASUREMENTS", "MEDICATION_RECORDS", "INTAKE_AND_ACTIVITY", "QUESTIONS_FOR_CARE_TEAM", "DATA_LIMITATIONS", "CARE_DRAFT_NOTICES"]);
    const text = payload.sections.flatMap((section) => section.blocks).map((block) => ("renderedText" in block ? block.renderedText : block.kind === "PATIENT_QUESTION" ? block.originalPatientText.text : "")).join("\n");
    // Exact entered values in time order, never normalised or interpreted.
    expect(text).toContain("Glucose readings\n3 Oct 2026, 7:30 am · 11.2 mmol/L\n3 Oct 2026, 9:00 pm · 6.60 mmol/L");
    expect(text).toContain("For Nocturin pen (demo), scheduled 30 Sept 2026 at 9:00 pm · Recorded as skipped");
    expect(text).toContain("Bishan Park 公园 · 25 min");
    expect(text).toContain("Dr Lim, Bukit Merah Polyclinic · 14 Oct 2026, 9:40 am\nAppointment entered by you · Details not verified by the clinic");
    expect(text).toContain("可以把笔放在包里吗？");
    expect(text).not.toMatch(/\bhigh\b|\blow\b|normal|target|adheren|missed dose|risk|diagnos|recommend|should|cause/i);
    const scope = payload.sections[0]!.blocks[0]!;
    expect(scope.kind === "SUMMARY_SCOPE" && scope.renderedText).toBe("For my appointment: Dr Lim, Bukit Merah Polyclinic\nRecords from 5 Sept 2026 – 4 Oct 2026\nPrepared on 4 Oct 2026, 10:00 am");
  });

  it("closes every source, keeps exclusions local and always states the selected-records limitation", async () => {
    const { payload, sourceRevisions } = await renderDeterministicCareSummary(draft());
    expect(sourceRevisions.map((source) => source.recordType)).toEqual(["APPOINTMENT", "GLUCOSE_READING", "GLUCOSE_READING", "MEDICATION_EVENT", "MEDICATION", "ACTIVITY_EVENT", "CARE_QUESTION"]);
    expect(payload.selection.excludedCandidates).toEqual([{ source: ref("INTAKE_EVENT", 8), reason: "NOT_SELECTED" }]);
    expect(payload.limitations.map((limitation) => limitation.code)).toEqual(["SELECTED_RECORDS_ONLY", "PATIENT_REPORTED_NOT_EXTERNALLY_VERIFIED", "MISSING_OR_UNRECORDED_DATA"]);
    // 11c.1: the care-draft notice section follows the limitations section.
    const limitationText = payload.sections.find((section) => section.sectionId === "DATA_LIMITATIONS")!.blocks.map((block) => (block.kind === "SUMMARY_LIMITATION" ? block.renderedText : ""));
    expect(limitationText[0]).toBe("This summary contains only the records and questions you selected.");
    // The export never reveals what was left out.
    expect(JSON.stringify(payload.sections)).not.toContain(id(8));
  });

  it("renders zh-SG directly from the same structured facts, with patient text unchanged", async () => {
    const zh = (await renderDeterministicCareSummary(draft("zh-SG"))).payload;
    const text = zh.sections.flatMap((section) => section.blocks).map((block) => ("renderedText" in block ? block.renderedText : "")).join("\n");
    expect(text).toContain("血糖读数");
    expect(text).toContain("2026年10月3日 下午9:00 · 6.60 mmol/L");
    // care-summary-locale.11c.1 (D4): the selected-records limitation addresses the reader with 您.
    expect(text).toContain("此摘要仅包含您所选择的记录和问题。");
    expect(text).not.toContain("此摘要仅包含你所选择的记录和问题。");
    expect(text).toContain("Dr Lim, Bukit Merah Polyclinic");
    expect(text).toContain("Bishan Park 公园");
    expect(text).not.toContain("Glucose readings");
    const bindings = (payload: typeof zh) => payload.sections.flatMap((section) => section.blocks).flatMap((block) => (block.kind === "RECORDED_FACT" ? block.factBindings : []));
    expect(bindings(zh)).toEqual(bindings((await renderDeterministicCareSummary(draft("en-SG"))).payload));
  });

  it("hashes deterministically, independent of object key order, and changes with any value", async () => {
    const first = await renderDeterministicCareSummary(draft());
    const second = await renderDeterministicCareSummary(draft());
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Reordered input keys produce the same canonical content.
    const reordered = draft();
    reordered.questions = [{ language: "zh-SG", text: "可以把笔放在包里吗？", ref: ref("CARE_QUESTION", 7) } as never];
    expect((await renderDeterministicCareSummary(reordered)).contentHash).toBe(first.contentHash);
    // Unicode is preserved exactly: a different code point is a different hash.
    const changed = draft();
    changed.questions = [{ ref: ref("CARE_QUESTION", 7), text: "可以把笔放在包里吗?", language: "zh-SG" }];
    expect((await renderDeterministicCareSummary(changed)).contentHash).not.toBe(first.contentHash);
    // Locale is part of the content: each locale has its own hash.
    expect((await renderDeterministicCareSummary(draft("zh-SG"))).contentHash).not.toBe(first.contentHash);
  });

  it("keeps unknown and approximate times explicit instead of substituting entry time", async () => {
    const value = draft();
    value.groups = [{ key: "WALKS", facts: [{ kind: "ACTIVITY", ref: ref("ACTIVITY_EVENT", 6), occurrence: { kind: "UNKNOWN" }, label: "Walk", minutes: null }] }];
    const { payload } = await renderDeterministicCareSummary(value);
    const block = payload.sections.find((section) => section.sectionId === "INTAKE_AND_ACTIVITY")!.blocks[0]!;
    expect(block.kind === "RECORDED_FACT" && block.renderedText).toBe("Walks\nTime not recorded · Walk");
  });

  it("renders under the 11c.1 template, renderer and locale-pack versions", async () => {
    const { payload } = await renderDeterministicCareSummary(draft());
    expect(payload.composition).toEqual({ method: "DETERMINISTIC", templateVersion: "care-summary-template.11c.1" });
    expect([payload.rendering.rendererVersion, payload.rendering.localePackVersion]).toEqual(["care-summary-renderer.11c.1", "care-summary-locale.11c.1"]);
    expect([CARE_SUMMARY_TEMPLATE_VERSION, CARE_SUMMARY_RENDERER_VERSION, CARE_SUMMARY_LOCALE_PACK_VERSION]).toEqual(["care-summary-template.11c.1", "care-summary-renderer.11c.1", "care-summary-locale.11c.1"]);
    expect(CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES).toContain(CARE_SUMMARY_TEMPLATE_VERSION);
  });

  it("fails closed when nothing factual is selected", async () => {
    const empty = draft();
    empty.appointment = null;
    empty.groups = [];
    empty.questions = [];
    await expect(renderDeterministicCareSummary(empty)).rejects.toThrow();
  });
});

/**
 * Packet 11C Addendum B, Task B1a (decision 5): the applicable approved care-draft notices are rendered into the snapshot as block
 * content at preparation time, from their one runtime source (AI_LANGUAGE_COPY.careDraftNotices), and the content hash covers them.
 */
describe("deterministic care-summary renderer: care-draft notices (Packet 11C B1a)", () => {
  const noticesOf = (payload: CareSummarySnapshotPayload) => {
    const section = payload.sections.at(-1)!;
    expect(section.sectionId).toBe("CARE_DRAFT_NOTICES");
    expect(section.titleLocaleAssetId).toBe("care-summary.section.draft-notices");
    return section.blocks.map((block) => (block.kind === "CARE_DRAFT_NOTICE" ? { blockId: block.blockId, noticeKind: block.noticeKind, text: block.renderedText } : null));
  };

  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`stores the questions notice then the draft notice, verbatim from the approved copy, with a questions section (${locale})`, async () => {
      const { payload } = await renderDeterministicCareSummary(draft(locale));
      expect(noticesOf(payload)).toEqual([
        { blockId: "notice.questions-in-own-words", noticeKind: "QUESTIONS_IN_OWN_WORDS", text: AI_LANGUAGE_COPY.careDraftNotices.questions[locale] },
        { blockId: "notice.draft-not-sent-or-reviewed", noticeKind: "DRAFT_NOT_SENT_OR_REVIEWED", text: AI_LANGUAGE_COPY.careDraftNotices.draft[locale] },
      ]);
      // The same selection and text as the approved care-draft renderer.
      expect(noticesOf(payload).map((notice) => notice?.text)).toEqual(careDraftNoticesFor(locale, true).map((notice) => notice.text));
    });

    it(`stores the draft notice alone without a questions section (${locale})`, async () => {
      const value = draft(locale);
      value.questions = [];
      const { payload } = await renderDeterministicCareSummary(value);
      expect(payload.sections.some((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM")).toBe(false);
      expect(noticesOf(payload)).toEqual([{ blockId: "notice.draft-not-sent-or-reviewed", noticeKind: "DRAFT_NOT_SENT_OR_REVIEWED", text: AI_LANGUAGE_COPY.careDraftNotices.draft[locale] }]);
    });
  }

  it("covers the notices with the content hash: any change to a notice or its presence changes the hash", async () => {
    const { payload, contentHash } = await renderDeterministicCareSummary(draft());
    const hashOf = (sections: CareSummarySnapshotPayload["sections"]) =>
      hashCanonicalJson(careSummaryExportProjection({ ...payload, sections, rendererVersion: payload.rendering.rendererVersion, localePackVersion: payload.rendering.localePackVersion }));
    expect(await hashOf(payload.sections)).toBe(contentHash);
    const notices = payload.sections.at(-1)!;
    const edited = { ...notices, blocks: notices.blocks.map((block, index) => (index === 1 && block.kind === "CARE_DRAFT_NOTICE" ? { ...block, renderedText: `${block.renderedText} ` } : block)) } as typeof notices;
    expect(await hashOf([...payload.sections.slice(0, -1), edited])).not.toBe(contentHash);
    expect(await hashOf(payload.sections.slice(0, -1))).not.toBe(contentHash);
  });

  it("keeps patient facts, values, questions and limitations exactly as before; only the notice section is added", async () => {
    const { payload } = await renderDeterministicCareSummary(draft());
    const content = payload.sections.filter((section) => section.sectionId !== "CARE_DRAFT_NOTICES");
    expect(content.at(-1)!.sectionId).toBe("DATA_LIMITATIONS");
    for (const block of content.flatMap((section) => section.blocks)) expect(block.kind).not.toBe("CARE_DRAFT_NOTICE");
    expect(JSON.stringify(payload.limitations)).not.toContain("notice");
  });
});
