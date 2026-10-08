import { describe, expect, it } from "vitest";
import { PACKET_11_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import type { AiTaskRequest } from "@/domain/ai";
import { AI_LANGUAGE_COPY } from "./ai-language-copy";
import { careDraftNoticesFor, renderCareDraftNotices } from "./care-draft-notices";

/**
 * P3 presentation correction (owner instruction 2026-10-08, offline): fixed bilingual application copy for a care preparation draft,
 * kept apart from patient facts and from the approved limitation copy. No action, sending or review capability is added.
 */
const fixture = (id: string) => PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === id)!.request;
const withoutQuestions = (request: AiTaskRequest): AiTaskRequest => {
  const copy = structuredClone(request) as any;
  const questions = copy.taskPayload.sections.find((section: any) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM");
  copy.taskPayload.sections = copy.taskPayload.sections.filter((section: any) => section !== questions);
  copy.facts = copy.facts.filter((fact: any) => !questions.factRefs.includes(fact.ref));
  return copy;
};

describe("care draft notices (ai-language-copy.11b.8)", () => {
  it("a care draft with recorded questions gets the questions notice, then the draft notice, in its locale", () => {
    expect(renderCareDraftNotices(fixture("p11.draft-care-preparation-summary.en-sg.forbidden-authority"))).toEqual([
      { kind: "QUESTIONS_IN_OWN_WORDS", text: "Questions are shown in your own words; the app does not carry them out." },
      { kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: "The app does not send this draft to your care team or confirm that a clinician has reviewed it." },
    ]);
    expect(renderCareDraftNotices(fixture("p11.draft-care-preparation-summary.zh-sg.forbidden-authority"))).toEqual([
      { kind: "QUESTIONS_IN_OWN_WORDS", text: "问题按您的原话显示，应用不会照此执行。" },
      { kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: "应用不会把此草稿发送给护理团队，也不会确认医护人员已审阅。" },
    ]);
  });
  it("a care draft without a questions section gets the draft notice only", () => {
    const request = withoutQuestions(fixture("p11.draft-care-preparation-summary.en-sg.prompt-injection"));
    expect(request.taskPayload).not.toHaveProperty("sections.1");
    expect(renderCareDraftNotices(request)).toEqual([{ kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"] }]);
  });
  it("careDraftNoticesFor (Packet 11C B1a) is the one selection rule both the care draft and the care-summary renderer use", () => {
    for (const entry of PACKET_11_HYBRID_FIXTURES.filter((item) => item.taskType === "DRAFT_CARE_PREPARATION_SUMMARY")) {
      for (const request of [entry.request, withoutQuestions(entry.request)]) {
        const hasQuestions = request.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" && request.taskPayload.sections.some((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM");
        expect(careDraftNoticesFor(request.locale, hasQuestions), entry.id).toEqual(renderCareDraftNotices(request));
      }
    }
    expect(careDraftNoticesFor("zh-SG", false)).toEqual([{ kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: AI_LANGUAGE_COPY.careDraftNotices.draft["zh-SG"] }]);
    expect(Object.isFrozen(careDraftNoticesFor("en-SG", true))).toBe(true);
  });
  it("an EXPLAIN request gets no care notice", () => {
    expect(renderCareDraftNotices(fixture("p11.explain-pattern.en-sg.prompt-injection"))).toEqual([]);
  });
  it("the notices are the same fixed copy for every care fixture and never carry supplied text", () => {
    for (const entry of PACKET_11_HYBRID_FIXTURES.filter((item) => item.taskType === "DRAFT_CARE_PREPARATION_SUMMARY")) {
      const notices = renderCareDraftNotices(entry.request);
      const copy = AI_LANGUAGE_COPY.careDraftNotices;
      expect(notices.map((notice) => notice.text), entry.id).toEqual([copy.questions[entry.locale], copy.draft[entry.locale]]);
      for (const fact of entry.request.facts) {
        const value = fact.value as { text?: string; value?: string | number };
        const supplied = value.text ?? (value.value === undefined ? null : String(value.value));
        if (supplied) for (const notice of notices) expect(notice.text, entry.id).not.toContain(supplied);
      }
    }
  });
});
