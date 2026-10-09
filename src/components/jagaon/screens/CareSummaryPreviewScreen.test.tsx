import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import type { Instant, RecordHead, RecordId } from "@/domain/shared";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, ENABLED_CARE_MANIFEST, exact, fakeModelCareShells, rewriteAsLegacy9c1Snapshot, testIds } from "@/application/care-preparation/care-preparation-test-support";
import type { CarePreparationCommandPort, CarePreparationQueryPort } from "@/application/care-preparation/care-preparation-contracts";
import type { CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { shellTaskRequestSchema, type AiTaskRequest } from "@/domain/ai";
import { renderCareDraftNotices } from "@/application/ai/language/care-draft-notices";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { shellPlanView } from "@/application/ai/language/shell-projector";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { createBrowserAiAssistance } from "@/application/ai/browser-history-explainer";
import type { BrowserShellFetcher } from "@/application/ai/browser-shell-client";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { PrintPort } from "../care-preparation/PrintPort";
import { CareSummaryPreviewScreen, type CareSummaryAiWordingOutcome, type CareSummaryAiWordingPort } from "./CareSummaryPreviewScreen";
// Packet 11C Addendum C (C1): the activated paths inject test-only QUALIFIED records (the shipped records are all PENDING).
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";

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
afterEach(async () => {
  cleanup();
  await closeCarePreparationHarnesses();
});

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };

async function prepared(locale: SupportedLocale = "en-SG", options: { questions?: boolean } = {}) {
  const h = await createCarePreparationHarness();
  const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  if (reading.kind !== "COMMITTED") throw new Error("reading");
  const question = await h.organisation.createCareQuestion({ questionText: { text: "可以把笔放在包里吗？", language: "zh-SG" } });
  if (question.kind !== "COMMITTED") throw new Error("question");
  const result = await h.service.prepare({ ...(await h.selection()), ...(options.questions === false ? { questions: [] } : {}), locale });
  if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
  return { h, recordId: result.recordId, reading };
}

function renderPreview(h: Awaited<ReturnType<typeof prepared>>["h"], recordId: RecordId, options: { print?: PrintPort; commands?: CarePreparationCommandPort; locale?: SupportedLocale; onBack?: () => void } = {}) {
  const locale = options.locale ?? "en-SG";
  return render(<CareSummaryPreviewScreen messages={getMessages(locale)} locale={locale} recordId={recordId} query={h.query} commands={options.commands ?? h.service} print={options.print ?? { print: vi.fn(async () => "DIALOG_OPENED" as const) }} onBack={options.onBack ?? vi.fn()} />);
}

async function approveWhenPreviewed(label: string) {
  const button = (await screen.findByRole("button", { name: label })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

const exportStates = async (h: Awaited<ReturnType<typeof prepared>>["h"], recordId: RecordId) => {
  const view = await h.query.loadSummary(recordId);
  return view.status === "READY" ? view.exports.map((entry) => entry.outcome.state) : [];
};

describe("Care-summary preview", () => {
  it("shows the exact prepared content, records the preview and binds approval to it", async () => {
    const { h, recordId } = await prepared();
    renderPreview(h, recordId);
    expect(screen.getByText(en.careSummary.loading)).toBeTruthy();
    const document = await screen.findByRole("article");
    expect(screen.getByRole("heading", { level: 1, name: en.careSummary.title })).toBeTruthy();
    expect(within(document).getByRole("heading", { name: en.careSummary.measurementsHeading })).toBeTruthy();
    expect(within(document).getByText("3 Oct 2026, 9:00 pm · 6.6 mmol/L")).toBeTruthy();
    expect(within(document).getByText("可以把笔放在包里吗？").getAttribute("lang")).toBe("zh-SG");
    expect(within(document).getByText(en.careSummary.selectedOnly)).toBeTruthy();
    await waitFor(async () => expect((await h.query.loadSummary(recordId)).status === "READY" && ((await h.query.loadSummary(recordId)) as { snapshotStatus: string }).snapshotStatus).toBe("PREVIEWED"));
    expect(screen.getByText(en.careSummary.approvalMeaning)).toBeTruthy();
    // No print control exists before approval.
    expect(screen.queryByRole("button", { name: en.careSummary.printAction })).toBeNull();
    await approveWhenPreviewed(en.careSummary.approveAction);
    expect(await screen.findByRole("button", { name: en.careSummary.printAction })).toBeTruthy();
    expect(screen.getAllByText(en.careSummary.approvedNote).length).toBeGreaterThan(0);
    const view = await h.query.loadSummary(recordId);
    expect(view.status === "READY" && view.payload.patientApproval.state === "APPROVED" && view.payload.patientApproval.approvedContentHash).toBe(view.status === "READY" && view.payload.rendering.contentHash);
  });

  it("records the attempt as REQUESTED before opening the print dialog, then its exact outcome", async () => {
    const { h, recordId } = await prepared();
    const order: string[] = [];
    const print: PrintPort = {
      print: vi.fn(async () => {
        order.push(`print:${(await exportStates(h, recordId)).join(",")}`);
        return "DIALOG_OPENED" as const;
      }),
    };
    renderPreview(h, recordId, { print });
    await approveWhenPreviewed(en.careSummary.approveAction);
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.printAction }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.careSummary.printOpened));
    expect(order).toEqual(["print:REQUESTED"]);
    expect(await exportStates(h, recordId)).toEqual(["EXPORTED"]);
  });

  it("makes every retry a new attempt and records unavailable printing honestly", async () => {
    const { h, recordId } = await prepared();
    const outcomes = ["UNAVAILABLE", "OUTCOME_UNKNOWN"] as const;
    let call = 0;
    renderPreview(h, recordId, { print: { print: vi.fn(async () => outcomes[call++]!) } });
    await approveWhenPreviewed(en.careSummary.approveAction);
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.printAction }));
    await waitFor(async () => expect(await exportStates(h, recordId)).toEqual(["FAILED"]));
    expect(screen.getAllByText(en.careSummary.printUnavailable).length).toBeGreaterThan(0);
    await waitFor(() => expect((screen.getByRole("button", { name: en.careSummary.printAction }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: en.careSummary.printAction }));
    await waitFor(async () => expect((await exportStates(h, recordId)).sort()).toEqual(["FAILED", "OUTCOME_UNKNOWN"]));
    const attempts = await screen.findByRole("list", { name: en.careSummary.attemptsHeading });
    expect(within(attempts).getAllByRole("listitem")).toHaveLength(2);
  });

  it("blocks approval and printing when a selected record changed, and offers the way back", async () => {
    const { h, recordId, reading } = await prepared();
    await h.journal.correctGlucoseTime({ recordId: reading.recordId, expectedRevisionId: reading.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    const onBack = vi.fn();
    renderPreview(h, recordId, { onBack });
    expect(await screen.findByText(en.careSummary.sourceChanged)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.careSummary.approveAction })).toBeNull();
    expect(screen.queryByRole("button", { name: en.careSummary.printAction })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: en.careSummary.backToPreparation })[0]!);
    expect(onBack).toHaveBeenCalled();
    // The stale snapshot was never marked previewed.
    const head = (await h.database.table("recordHeads").get(recordId)) as RecordHead;
    expect(head.headRevisionNumber).toBe(1);
  });

  it("shows the hash-mismatch notice when export preflight refuses the approved content", async () => {
    const { h, recordId } = await prepared();
    const commands: CarePreparationCommandPort = { ...h.service, requestPrintExport: async () => ({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" }) };
    const print = { print: vi.fn(async () => "DIALOG_OPENED" as const) };
    renderPreview(h, recordId, { commands, print });
    await approveWhenPreviewed(en.careSummary.approveAction);
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.printAction }));
    expect(await screen.findByText(en.careSummary.hashMismatch)).toBeTruthy();
    // Preflight failure means no side effect and no attempt record.
    expect(print.print).not.toHaveBeenCalled();
    expect(await exportStates(h, recordId)).toEqual([]);
  });

  it("renders a zh-SG snapshot directly and never claims sending, delivery or review", async () => {
    const { h, recordId } = await prepared("zh-SG");
    const { container } = renderPreview(h, recordId, { locale: "zh-SG" });
    await screen.findByRole("article");
    expect(screen.getByRole("heading", { level: 1, name: zh.careSummary.title })).toBeTruthy();
    expect(within(screen.getByRole("article")).getByText(zh.careSummary.selectedOnly)).toBeTruthy();
    await approveWhenPreviewed(zh.careSummary.approveAction);
    await screen.findByRole("button", { name: zh.careSummary.printAction });
    expect(container.textContent).not.toMatch(/已发送|已送达|已收到|医护人员已审核|诊所已确认/);
    cleanup();
    const { container: english } = renderPreview(h, recordId);
    await screen.findByRole("article");
    const visible = (english.textContent ?? "").replaceAll(en.careSummary.approvalMeaning, "").replaceAll(en.carePreparation.localOnly, "").replaceAll(en.careSummary.patientReported, "");
    expect(visible).not.toMatch(/\bsent\b|delivered|received|reviewed by|clinician confirmed|confirmed by/i);
  });

  it("shows unavailable storage without inventing a summary", async () => {
    render(<CareSummaryPreviewScreen messages={en} locale="en-SG" recordId={"x" as never} query={{ loadSummary: async () => ({ status: "UNAVAILABLE" }) }} commands={null} print={{ print: vi.fn() }} onBack={vi.fn()} />);
    expect(await screen.findByText(en.careSummary.unavailableTitle)).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
});

/**
 * Minimal request-shaped adapter (test-only; not in the browser graph): `renderCareDraftNotices` reads only the task type,
 * the locale and the section ids, so those are taken from the snapshot and nothing else is invented.
 */
function approvedNoticeTexts(payload: { locale: SupportedLocale; sections: ReadonlyArray<{ sectionId: string }> }): string[] {
  const request = { taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: payload.locale, taskPayload: { sections: payload.sections.map((section) => ({ sectionId: section.sectionId })) } } as unknown as AiTaskRequest;
  return renderCareDraftNotices(request).map((notice) => notice.text);
}

/**
 * Packet 11C Addendum B, Task B1a (decision 5): the notices are the printed summary's own last section ("Notes about this draft"),
 * rendered from the snapshot's stored, hashed notice blocks. The Checkpoint 2 screen-only region no longer exists.
 */
async function noticeSection(locale: SupportedLocale = "en-SG") {
  const article = await screen.findByRole("article");
  const heading = within(article).getByRole("heading", { level: 2, name: getMessages(locale).careSummary.draftNotices.label });
  return heading.closest("section") as HTMLElement;
}

const noticeTexts = (section: HTMLElement) => within(section).getAllByRole("paragraph").map((paragraph) => paragraph.textContent);

describe("Care-summary preview: Packet 11C appointment preview (A3) with notices in the printed artifact (B1a)", () => {
  it("prints the fixed care-draft notices as the summary's last section, after “About this summary”, with no screen-only copy", async () => {
    const { h, recordId } = await prepared();
    renderPreview(h, recordId);
    const article = await screen.findByRole("article");
    const section = await noticeSection();
    const headings = within(article).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(-2)).toEqual([en.careSummary.limitationsHeading, en.careSummary.draftNotices.label]);
    expect(article.contains(section)).toBe(true);
    expect(noticeTexts(section)).toEqual([AI_LANGUAGE_COPY.careDraftNotices.questions["en-SG"], AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]]);
    // Not part of the limitation list, and nowhere outside the printed summary.
    const limitations = within(article).getByRole("heading", { level: 2, name: en.careSummary.limitationsHeading }).closest("section") as HTMLElement;
    for (const text of noticeTexts(section)) expect(limitations.textContent).not.toContain(text);
    expect(screen.queryByRole("region", { name: en.careSummary.draftNotices.label })).toBeNull();
    expect(document.querySelector(".care-summary-draft-notices")).toBeNull();
    const outside = (document.body.textContent ?? "").replace(article.textContent ?? "", "");
    for (const text of noticeTexts(section)) expect(outside).not.toContain(text);
  });

  it("shows the questions notice only when the summary has a questions section", async () => {
    const { h, recordId } = await prepared("en-SG", { questions: false });
    renderPreview(h, recordId);
    const article = await screen.findByRole("article");
    expect(within(article).queryByRole("heading", { name: en.careSummary.questionsHeading })).toBeNull();
    expect(noticeTexts(await noticeSection())).toEqual([AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]]);
  });

  it("keeps approval a separate click with its meaning visible, and print reachable only after approval", async () => {
    const { h, recordId } = await prepared();
    renderPreview(h, recordId);
    await noticeSection();
    const approve = (await screen.findByRole("button", { name: en.careSummary.approveAction })) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.getByText(en.careSummary.approvalMeaning)).toBeTruthy();
    // Previewing never approves on its own, and printing is not offered yet.
    const before = await h.query.loadSummary(recordId);
    expect(before.status === "READY" && [before.snapshotStatus, before.payload.patientApproval.state]).toEqual(["PREVIEWED", "NOT_APPROVED"]);
    expect(screen.queryByRole("button", { name: en.careSummary.printAction })).toBeNull();
    fireEvent.click(approve);
    expect(await screen.findByRole("button", { name: en.careSummary.printAction })).toBeTruthy();
    const after = await h.query.loadSummary(recordId);
    expect(after.status === "READY" && after.snapshotStatus).toBe("APPROVED");
    // The approved hash is the hash of the artifact that contains the notices.
    expect(after.status === "READY" && after.payload.patientApproval.state === "APPROVED" && after.payload.patientApproval.approvedContentHash).toBe(before.status === "READY" && before.payload.rendering.contentHash);
    expect(before.status === "READY" && before.payload.sections.at(-1)!.sectionId).toBe("CARE_DRAFT_NOTICES");
    expect(noticeTexts(await noticeSection())).toEqual([AI_LANGUAGE_COPY.careDraftNotices.questions["en-SG"], AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]]);
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`offers no send, share or email action and makes no review or delivery claim outside the notices' negated sentences (${locale})`, async () => {
      const { h, recordId } = await prepared(locale);
      const { container } = renderPreview(h, recordId, { locale });
      const messages = getMessages(locale).careSummary;
      const region = await noticeSection(locale);
      const scan = () => {
        const actions = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")].map((element) => element.textContent ?? "");
        expect(actions.length).toBeGreaterThan(0);
        for (const name of actions) expect(name).not.toMatch(/send|share|email|發送|发送|分享/i);
        // The approved Packet 9 local-only notice ("Nothing is sent to anyone automatically.") is an existing denial sentence,
        // byte-identical and outside this task; it is pinned as a denial and set aside like the care-draft notices.
        const localOnly = getMessages(locale).carePreparation.localOnly;
        expect(localOnly).toMatch(locale === "en-SG" ? /^Stays on this phone\. Nothing is sent to anyone automatically\.$/ : /不会/);
        const text = (container.textContent ?? "").replaceAll(localOnly, "");
        // Otherwise the notices are the only place such words appear, and only inside their negated sentences.
        const outside = noticeTexts(region).reduce((rest, notice) => rest.replaceAll(notice ?? "", ""), text);
        expect(outside).not.toMatch(/reviewed by|sent to|已审阅|已发送/i);
      };
      expect(container.textContent).toContain(AI_LANGUAGE_COPY.careDraftNotices.draft[locale]);
      expect(messages.draftNotices.label.length).toBeGreaterThan(0);
      scan();
      await approveWhenPreviewed(messages.approveAction);
      await screen.findByRole("button", { name: messages.printAction });
      scan();
    });
  }

  it("shows only the snapshot's selected sources", async () => {
    const h = await createCarePreparationHarness();
    const selected = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
    const unselected = await h.journal.recordGlucose({ payload: { ...glucosePayload, measurement: { ...glucosePayload.measurement, enteredValue: "9.4" as never } }, temporal: { kind: "POINT", occurrence: exact("2026-10-02T13:00:00.000Z") }, recordedAt: NOW });
    const asked = await h.organisation.createCareQuestion({ questionText: { text: "Selected question words", language: "en-SG" } });
    const notAsked = await h.organisation.createCareQuestion({ questionText: { text: "Unselected question words", language: "en-SG" } });
    if (selected.kind !== "COMMITTED" || unselected.kind !== "COMMITTED" || asked.kind !== "COMMITTED" || notAsked.kind !== "COMMITTED") throw new Error("fixture");
    const ref = <T extends string>(recordType: T, created: { recordId: RecordId; revisionId: unknown }) => ({ recordType, recordId: created.recordId, revisionId: created.revisionId as never });
    const selection = await h.selection();
    const result = await h.service.prepare({
      ...selection,
      groups: [{ key: "GLUCOSE", sources: [ref("GLUCOSE_READING" as const, selected)] }],
      questions: [ref("CARE_QUESTION" as const, asked)],
      notSelected: [ref("GLUCOSE_READING" as const, unselected), ref("CARE_QUESTION" as const, notAsked)],
    });
    if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
    const { container } = renderPreview(h, result.recordId);
    const article = await screen.findByRole("article");
    await noticeSection();
    expect(within(article).getByText("3 Oct 2026, 9:00 pm · 6.6 mmol/L")).toBeTruthy();
    expect(within(article).getByText("Selected question words")).toBeTruthy();
    expect(container.textContent).not.toContain("9.4");
    expect(container.textContent).not.toContain("Unselected question words");
  });
});

describe("Care-summary preview: stored care-draft notice blocks are the approved copy, verbatim", () => {
  // Packet 11C B1a (retargeted pin): the notice text has one runtime source, the approved copy (AI_LANGUAGE_COPY.careDraftNotices,
  // ai-language-copy.11b.10, unchanged since 11b.8). It is rendered into the snapshot's CARE_DRAFT_NOTICE blocks at preparation
  // time; the screen and the printable artifact show those stored blocks. The Checkpoint 2 i18n mirror no longer exists.
  it("keeps no i18n mirror of the notice text", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      expect(Object.keys(getMessages(locale).careSummary.draftNotices), locale).toEqual(["label"]);
      expect(JSON.stringify(getMessages(locale)), locale).not.toContain(AI_LANGUAGE_COPY.careDraftNotices.draft[locale]);
    }
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    for (const questions of [true, false]) {
      it(`stores and shows exactly the approved renderer's notices (${locale}, ${questions ? "with" : "without"} a questions section)`, async () => {
        const { h, recordId } = await prepared(locale, { questions });
        renderPreview(h, recordId, { locale });
        const rendered = noticeTexts(await noticeSection(locale));
        const view = await h.query.loadSummary(recordId);
        if (view.status !== "READY") throw new Error("ready");
        expect(view.payload.sections.some((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM")).toBe(questions);
        const stored = view.payload.sections.at(-1)!.blocks.map((block) => (block.kind === "CARE_DRAFT_NOTICE" ? block.renderedText : null));
        const approved = approvedNoticeTexts(view.payload);
        const copy = AI_LANGUAGE_COPY.careDraftNotices;
        expect(approved).toEqual(questions ? [copy.questions[locale], copy.draft[locale]] : [copy.draft[locale]]);
        expect(stored).toEqual(approved);
        expect(rendered).toEqual(approved);
        for (const [index, text] of approved.entries()) {
          expect(Buffer.from(stored[index] ?? "", "utf8").equals(Buffer.from(text, "utf8"))).toBe(true);
          expect(Buffer.from(rendered[index] ?? "", "utf8").equals(Buffer.from(text, "utf8"))).toBe(true);
        }
      });
    }
  }
});

/**
 * Packet 11C Addendum B, Task B1a (D3): an unapproved preview made with an older template or renderer is shown as it was stored, but
 * it must be prepared again before approval. The message is non-technical and the way back to the existing "prepare" action is offered.
 */
describe("Care-summary preview: an older-version preview must be prepared again (D3)", () => {
  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`shows the stored 9c.1 preview unchanged, offers no approval, never records a preview, and offers the way back (${locale})`, async () => {
      const { h, recordId } = await prepared(locale);
      const legacy = await rewriteAsLegacy9c1Snapshot(h.database, recordId);
      const onBack = vi.fn();
      renderPreview(h, recordId, { locale, onBack });
      const messages = getMessages(locale).careSummary;
      expect(await screen.findByText(messages.templateSuperseded)).toBeTruthy();
      const article = screen.getByRole("article");
      // The old artifact is shown exactly as stored: no notice section is added to it.
      expect(within(article).queryByRole("heading", { name: messages.draftNotices.label })).toBeNull();
      expect(article.textContent).toBe(printableCareSummaryText(legacy));
      expect(screen.queryByRole("button", { name: messages.approveAction })).toBeNull();
      expect(screen.queryByRole("button", { name: messages.printAction })).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: messages.backToPreparation })[0]!);
      expect(onBack).toHaveBeenCalled();
      // Showing it never recorded a preview: the snapshot is still revision 1.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(((await h.database.table("recordHeads").get(recordId)) as RecordHead).headRevisionNumber).toBe(1);
    });
  }

  it("blocks approval of a previewed 9c.1 snapshot the same way", async () => {
    const { h, recordId } = await prepared();
    const view = await h.query.loadSummary(recordId);
    if (view.status !== "READY") throw new Error("ready");
    const previewed = await h.service.markPreviewed({ recordId, expectedRevisionId: view.revisionId, expectedRevisionNumber: 1, contentHash: view.payload.rendering.contentHash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    await rewriteAsLegacy9c1Snapshot(h.database, recordId);
    renderPreview(h, recordId);
    expect(await screen.findByText(en.careSummary.templateSuperseded)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.careSummary.approveAction })).toBeNull();
  });

  it("shows the same message when the service refuses approval with SUMMARY_TEMPLATE_SUPERSEDED", async () => {
    const { h, recordId } = await prepared();
    const commands: CarePreparationCommandPort = { ...h.service, approve: async () => ({ kind: "REJECTED", code: "SUMMARY_TEMPLATE_SUPERSEDED" }) };
    renderPreview(h, recordId, { commands });
    await approveWhenPreviewed(en.careSummary.approveAction);
    expect(await screen.findByText(en.careSummary.templateSuperseded)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.careSummary.approveAction })).toBeNull();
    expect(screen.getAllByRole("button", { name: en.careSummary.backToPreparation }).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.carePreparation.saveFailed)).toBeNull();
  });

  it("keeps an approved 9c.1 snapshot printable exactly as approved", async () => {
    const { h, recordId } = await prepared();
    const view = await h.query.loadSummary(recordId);
    if (view.status !== "READY") throw new Error("ready");
    const previewed = await h.service.markPreviewed({ recordId, expectedRevisionId: view.revisionId, expectedRevisionNumber: 1, contentHash: view.payload.rendering.contentHash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    const approved = await h.service.approve({ recordId, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: previewed.revisionNumber, contentHash: view.payload.rendering.contentHash });
    if (approved.kind !== "COMMITTED") throw new Error("approved");
    const legacy = await rewriteAsLegacy9c1Snapshot(h.database, recordId);
    renderPreview(h, recordId);
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.printAction }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.careSummary.printOpened));
    expect(screen.queryByText(en.careSummary.templateSuperseded)).toBeNull();
    expect(screen.getByRole("article").textContent).toBe(printableCareSummaryText(legacy));
    const after = await h.query.loadSummary(recordId);
    expect(after.status === "READY" && [after.snapshotStatus, after.payload.rendering.contentHash, after.exports.map((entry) => entry.outcome.state)]).toEqual(["APPROVED", legacy.rendering.contentHash, ["EXPORTED"]]);
  });
});

/**
 * Packet 11C Addendum B, Task B4b (original Task 5, care part): the "Organise with AI" action on the preview. Shown only when the care
 * task is remote-enabled and online, on the current, unapproved, current-template, deterministic preview; never while NOT_ACTIVATED. The
 * disclosure comes before any request; the deterministic preview stays readable while a request runs; an accepted replacement loads the
 * NEW preview with the AI label and check notice; approval stays a separate click; nothing prints on its own. New presentation: human
 * acceptance pending. Activated behaviour only with a fake port or an injected test manifest and a fake route.
 */
type Deferred = { input: { snapshotRef: { recordId: RecordId; expectedRevisionId: string; expectedRevisionNumber: number }; locale: string; disclosure?: "ACCEPTED" | "DECLINED" }; signal?: AbortSignal; resolve: (outcome: CareSummaryAiWordingOutcome) => void };

/** Packet 11C Addendum C (C3): per-request disclosure, so `required` never changes after an acceptance (there is no session). */
function fakeWording(options: { available?: boolean; required?: boolean } = {}) {
  const required = options.required ?? false;
  const calls: Deferred[] = [];
  const port = {
    available: vi.fn((_current: CareSummarySnapshotPayload) => options.available ?? true),
    disclosureRequired: vi.fn((_current: CareSummarySnapshotPayload) => required),
    compose: vi.fn((input: Deferred["input"], signal?: AbortSignal) => new Promise<CareSummaryAiWordingOutcome>((resolve) => void calls.push({ input, signal, resolve }))),
    // Packet 11C Addendum C (C5): the moot disclosure's audit row.
    disclosureClosed: vi.fn(async (_input: { locale: SupportedLocale }) => undefined),
  } satisfies CareSummaryAiWordingPort;
  return { port, calls };
}

/** Renders the preview as the app does: a replacement moves the same screen to the new snapshot's record. */
function AiPreviewHarness(props: { h: Awaited<ReturnType<typeof prepared>>["h"]; recordId: RecordId; locale: SupportedLocale; aiWording: CareSummaryAiWordingPort | null; commands?: CarePreparationCommandPort; print?: PrintPort; onReplaced?: (recordId: RecordId) => void; query?: CarePreparationQueryPort }) {
  const [recordId, setRecordId] = useState(props.recordId);
  return (
    <CareSummaryPreviewScreen
      messages={getMessages(props.locale)}
      locale={props.locale}
      recordId={recordId}
      query={props.query ?? props.h.query}
      commands={props.commands ?? props.h.service}
      print={props.print ?? { print: vi.fn(async () => "DIALOG_OPENED" as const) }}
      onBack={vi.fn()}
      aiWording={props.aiWording}
      onReplaced={(next) => {
        props.onReplaced?.(next);
        setRecordId(next);
      }}
    />
  );
}

function renderAi(h: Awaited<ReturnType<typeof prepared>>["h"], recordId: RecordId, aiWording: CareSummaryAiWordingPort | null, options: { locale?: SupportedLocale; commands?: CarePreparationCommandPort; print?: PrintPort; onReplaced?: (recordId: RecordId) => void; query?: CarePreparationQueryPort } = {}) {
  const locale = options.locale ?? "en-SG";
  const result = render(<AiPreviewHarness h={h} recordId={recordId} locale={locale} aiWording={aiWording} commands={options.commands} print={options.print} onReplaced={options.onReplaced} query={options.query} />);
  return { ...result, rerenderLocale: (next: SupportedLocale) => result.rerender(<AiPreviewHarness h={h} recordId={recordId} locale={next} aiWording={aiWording} commands={options.commands} print={options.print} onReplaced={options.onReplaced} query={options.query} />) };
}

/** The action, once the preview has been recorded (like approval, it is enabled on the PREVIEWED snapshot only). */
async function aiAction(locale: SupportedLocale = "en-SG") {
  const button = (await screen.findByRole("button", { name: getMessages(locale).ai.careSummary.action })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

/** A preview the AI path can phrase: the appointment, one reading and the questions (en-SG question text). */
async function aiPrepared(locale: SupportedLocale = "en-SG") {
  const h = await createCarePreparationHarness();
  const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  const question = await h.organisation.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
  if (reading.kind !== "COMMITTED" || question.kind !== "COMMITTED") throw new Error("fixture");
  const result = await h.service.prepare({ ...(await h.selection()), locale });
  if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
  return { h, recordId: result.recordId, reading };
}

describe("Care-summary preview: AI wording action (Packet 11C B4b)", () => {
  it("is absent without the wording port, and while the care task is not activated (shipped manifest: nothing offered or sent)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const shippedPort of [false, true]) {
        const { h, recordId } = await prepared();
        const audit = { append: vi.fn(async () => undefined) };
        const port = shippedPort ? createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands: h.service }, audit }).careSummary : null;
        const view = renderAi(h, recordId, port);
        // Before and after approval: no action, no dialog, no AI label; the ordinary preview flow is unchanged.
        await screen.findByRole("article");
        expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
        await approveWhenPreviewed(en.careSummary.approveAction);
        expect(await screen.findByRole("button", { name: en.careSummary.printAction })).toBeTruthy();
        expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByText(en.ai.careSummary.resultTitle)).toBeNull();
        expect(audit.append).not.toHaveBeenCalled();
        view.unmount();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is offered on the current unapproved deterministic preview, before the approval controls, and never while offline", async () => {
    const { h, recordId } = await prepared();
    const { port } = fakeWording();
    renderAi(h, recordId, port);
    const action = await aiAction();
    const approve = screen.getByRole("button", { name: en.careSummary.approveAction });
    expect(action.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(port.compose).not.toHaveBeenCalled();
    cleanup();
    const offline = fakeWording({ available: false });
    renderAi(h, recordId, offline.port);
    await approveWhenPreviewed(en.careSummary.approveAction);
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
  });

  it("is never offered on an approved, source-changed or older-version snapshot (the D3 re-prepare message instead)", async () => {
    const approved = await prepared();
    const one = fakeWording();
    renderAi(approved.h, approved.recordId, one.port);
    await approveWhenPreviewed(en.careSummary.approveAction);
    await screen.findByRole("button", { name: en.careSummary.printAction });
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
    cleanup();

    const stale = await prepared();
    await stale.h.journal.correctGlucoseTime({ recordId: stale.reading.recordId, expectedRevisionId: stale.reading.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    renderAi(stale.h, stale.recordId, fakeWording().port);
    expect(await screen.findByText(en.careSummary.sourceChanged)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
    cleanup();

    const outdated = await prepared();
    await rewriteAsLegacy9c1Snapshot(outdated.h.database, outdated.recordId);
    renderAi(outdated.h, outdated.recordId, fakeWording().port);
    expect(await screen.findByText(en.careSummary.templateSuperseded)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
  });

  it("shows the disclosure before any request; Cancel sends nothing and keeps the standard wording", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording({ required: true });
    renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    const dialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(within(dialog).getByRole("button", { name: en.ai.careSummary.confirm })).toBeTruthy();
    expect(port.compose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: en.ai.cancel }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    expect(calls[0]!.input).toMatchObject({ snapshotRef: { recordId }, locale: "en-SG", disclosure: "DECLINED" });
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "REQUEST_CANCELLED" }));
    expect(await screen.findByText(en.ai.remoteNotAccepted)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(en.ai.careSummary.resultTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: en.ai.retry })).toBeNull();
  });

  it("loading keeps the deterministic preview readable with Cancel; approval waits; Cancel aborts and discards the late answer", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording({ required: true });
    renderAi(h, recordId, port);
    const before = (await screen.findByRole("article")).textContent;
    fireEvent.click(await aiAction());
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.careSummary.confirm }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    // Packet 11C Addendum C (C3): the acceptance travels with this one request, bound to its own signal.
    expect(calls[0]!.input.disclosure).toBe("ACCEPTED");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText(en.ai.careSummary.loading)).toBeTruthy();
    expect(screen.getByRole("article").textContent).toBe(before);
    expect((screen.getByRole("button", { name: en.careSummary.approveAction }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: en.ai.cancel }));
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await screen.findByText(en.ai.cancelled)).toBeTruthy();
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_FAILED" }));
    await act(async () => undefined);
    expect(screen.queryByText(en.ai.unavailable, { exact: false })).toBeNull();
    expect(screen.getByRole("article").textContent).toBe(before);
    await waitFor(() => expect((screen.getByRole("button", { name: en.careSummary.approveAction }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("a provider or validator fallback keeps the preview with the unavailable and fallback lines and a retry; no technical code", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording();
    renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "SCHEMA_INVALID" }));
    expect(await screen.findByText(`${en.ai.unavailable} ${en.ai.careSummary.fallback}`)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SCHEMA_INVALID|PROVIDER_|KEPT_DETERMINISTIC/);
    fireEvent.click(screen.getByRole("button", { name: en.ai.retry }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => calls[1]!.resolve({ kind: "UNAVAILABLE" }));
    expect(await screen.findByText(`${en.ai.unavailable} ${en.ai.careSummary.fallback}`)).toBeTruthy();
    // A closed, non-recoverable outcome offers no retry.
    expect(screen.queryByRole("button", { name: en.ai.retry })).toBeNull();
  });

  it("C3: each explicit request asks again; an accepted request's Retry is a new request with a new dialog and a new signal", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording({ required: true });
    renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.careSummary.confirm }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    expect(calls[0]!.input.disclosure).toBe("ACCEPTED");
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_TIMEOUT" }));
    // Retry: the previous acceptance does not carry over; the dialog is shown again before anything is requested.
    fireEvent.click(await screen.findByRole("button", { name: en.ai.retry }));
    const again = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(port.compose).toHaveBeenCalledTimes(1);
    expect(port.disclosureRequired).toHaveBeenCalledTimes(2);
    fireEvent.click(within(again).getByRole("button", { name: en.ai.careSummary.confirm }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(2));
    expect(calls[1]!.input.disclosure).toBe("ACCEPTED");
    expect(calls[1]!.signal).not.toBe(calls[0]!.signal);
    act(() => calls[1]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_TIMEOUT" }));
    // Declining the next one sends that request with its decline only.
    fireEvent.click(await screen.findByRole("button", { name: en.ai.retry }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.cancel }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(3));
    expect(calls.map((call) => call.input.disclosure)).toEqual(["ACCEPTED", "ACCEPTED", "DECLINED"]);
  });

  it("C3: the AI action is hidden when this preview's own request could not be sent (its class not qualified); asked with the preview", async () => {
    const { h, recordId } = await prepared();
    const { port } = fakeWording({ available: false, required: true });
    renderAi(h, recordId, port);
    await approveWhenPreviewed(en.careSummary.approveAction);
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(port.available).toHaveBeenCalled();
    for (const call of port.available.mock.calls) expect(call[0]).toMatchObject({ locale: "en-SG", composition: { method: "DETERMINISTIC" } });
    expect(port.compose).not.toHaveBeenCalled();
  });

  it("a preview that cannot be organised says so in plain words, with no disclosure and no retry", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording({ required: false });
    renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    act(() => calls[0]!.resolve({ kind: "NOT_ELIGIBLE", reason: "TOO_MANY_FACTS" }));
    expect(await screen.findByText(`${en.ai.careSummary.notEligible} ${en.ai.careSummary.fallback}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.ai.retry })).toBeNull();
    expect(document.body.textContent).not.toMatch(/TOO_MANY|NOT_ELIGIBLE/);
  });

  it("a changed source or head discards the result, says so and reloads the latest summary (which then blocks approval)", async () => {
    const { h, recordId, reading } = await prepared();
    const { port, calls } = fakeWording();
    const loads = vi.fn(h.query.loadSummary);
    renderAi(h, recordId, port, { query: { loadSummary: loads } });
    fireEvent.click(await aiAction());
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    await h.journal.correctGlucoseTime({ recordId: reading.recordId, expectedRevisionId: reading.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    const loadsBefore = loads.mock.calls.length;
    act(() => calls[0]!.resolve({ kind: "STALE" }));
    expect(await screen.findByText(en.ai.careSummary.changed)).toBeTruthy();
    await waitFor(() => expect(loads.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(await screen.findByText(en.careSummary.sourceChanged)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.careSummary.approveAction })).toBeNull();
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
  });

  it("a locale switch closes an open disclosure and aborts a pending request; nothing is shown from the late answer", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording({ required: true });
    const view = renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    view.rerenderLocale("zh-SG");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(port.compose).not.toHaveBeenCalled();
    view.rerenderLocale("en-SG");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(await aiAction());
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.careSummary.confirm }));
    await screen.findByText(en.ai.careSummary.loading);
    view.rerenderLocale("zh-SG");
    await waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true));
    expect(screen.queryByText(zh.ai.careSummary.loading)).toBeNull();
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_FAILED" }));
    await act(async () => undefined);
    expect(screen.queryByText(zh.ai.unavailable, { exact: false })).toBeNull();
    expect(screen.queryByText(zh.ai.cancelled)).toBeNull();
  });

  it("C5: a disclosure closed as moot (locale switch, screen closed) reports its one moot request; an answered one never does", async () => {
    const { h, recordId } = await prepared();
    const { port } = fakeWording({ required: true });
    const view = renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(port.disclosureClosed).not.toHaveBeenCalled();
    view.rerenderLocale("zh-SG");
    await waitFor(() => expect(port.disclosureClosed).toHaveBeenCalledTimes(1));
    // The request's own locale (the preview's), not the locale switched to.
    expect(port.disclosureClosed).toHaveBeenCalledWith({ locale: "en-SG" });
    view.rerenderLocale("en-SG");
    await act(async () => undefined);

    fireEvent.click(await aiAction());
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    view.unmount();
    await waitFor(() => expect(port.disclosureClosed).toHaveBeenCalledTimes(2));
    expect(port.compose).not.toHaveBeenCalled();

    // Answered (Cancel, or the primary action): the request runs and is audited by it, never also as moot.
    cleanup();
    const answered = fakeWording({ required: true });
    const again = renderAi(h, recordId, answered.port);
    fireEvent.click(await aiAction());
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.cancel }));
    await waitFor(() => expect(answered.port.compose).toHaveBeenCalledTimes(1));
    again.unmount();
    await act(async () => undefined);
    expect(answered.port.disclosureClosed).not.toHaveBeenCalled();
  });

  it("unmounting aborts a pending request", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording();
    const view = renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_FAILED" }));
    await act(async () => undefined);
  });

  it.each(["en-SG", "zh-SG"] as const)("states in %s use the catalogue copy", async (locale) => {
    const { h, recordId } = await prepared(locale);
    const messages = getMessages(locale);
    const { port, calls } = fakeWording();
    renderAi(h, recordId, port, { locale });
    fireEvent.click(await aiAction(locale));
    expect(await screen.findByText(messages.ai.careSummary.loading)).toBeTruthy();
    expect(screen.getByRole("button", { name: messages.ai.cancel })).toBeTruthy();
    act(() => calls[0]!.resolve({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_TIMEOUT" }));
    // Fix round 1: en-SG joins the two sentences with a space; zh-SG joins them directly (no ASCII space after "。").
    const line = locale === "zh-SG" ? `${messages.ai.unavailable}${messages.ai.careSummary.fallback}` : `${messages.ai.unavailable} ${messages.ai.careSummary.fallback}`;
    expect(await screen.findByText(line)).toBeTruthy();
    if (locale === "zh-SG") {
      expect(line).toBe("AI 目前无法使用。您已记录的资料没有改变。即使不使用 AI，您的结构化摘要仍可使用。");
      expect(document.body.textContent).not.toMatch(/。 /);
    }
    fireEvent.click(screen.getByRole("button", { name: messages.ai.retry }));
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(2));
    act(() => calls[1]!.resolve({ kind: "STALE" }));
    expect(await screen.findByText(messages.ai.careSummary.changed)).toBeTruthy();
  });
});

describe("Care-summary preview: accepted AI wording (Packet 11C B4b; injected test manifest and fake route)", () => {
  const LATER = "2026-10-04T02:05:00.000Z" as Instant;

  /** The real wiring (one hybrid service, the browser shell client, a session) over a care service with the AI projection. */
  async function activated(locale: SupportedLocale = "en-SG") {
    const { h, recordId } = await aiPrepared(locale);
    const commands = createCarePreparationService(h.database, { now: () => LATER, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
    const audits = createAiInvocationAuditRepository(h.database);
    const fetcher = vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate: shellCandidate(plan, fakeModelCareShells(plan)), retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands }, audit: audits, manifest: ENABLED_CARE_MANIFEST, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
    return { h, recordId, commands, audits, fetcher, wording };
  }

  it.each(["en-SG", "zh-SG"] as const)("loads the NEW preview with the AI label and check notice; approval stays a separate click; nothing prints (%s)", async (locale) => {
    const messages = getMessages(locale);
    const ai = await activated(locale);
    const print = { print: vi.fn(async () => "DIALOG_OPENED" as const) };
    const onReplaced = vi.fn();
    renderAi(ai.h, ai.recordId, ai.wording, { locale, commands: ai.commands, print, onReplaced });
    const before = (await screen.findByRole("article")).textContent;
    fireEvent.click(await aiAction(locale));
    fireEvent.click(within(await screen.findByRole("dialog", { name: messages.ai.remoteTitle })).getByRole("button", { name: messages.ai.careSummary.confirm }));
    const region = await screen.findByRole("region", { name: messages.ai.careSummary.resultTitle });
    expect(within(region).getByText(messages.ai.careSummary.resultBody)).toBeTruthy();
    // Focus moves to the labelled AI region of the new preview (it is announced by its label).
    await waitFor(() => expect(document.activeElement).toBe(region));
    expect(ai.fetcher).toHaveBeenCalledTimes(1);
    expect(onReplaced).toHaveBeenCalledTimes(1);
    const newId = onReplaced.mock.calls[0]![0] as RecordId;
    expect(newId).not.toBe(ai.recordId);
    await waitFor(() => expect(screen.getByRole("article").textContent).not.toBe(before));
    // The new snapshot is AI-assisted, recorded as previewed by the ordinary flow, and NOT approved.
    await waitFor(async () => {
      const view = await ai.h.query.loadSummary(newId);
      expect(view.status === "READY" && [view.snapshotStatus, view.payload.composition.method, view.payload.patientApproval.state]).toEqual(["PREVIEWED", "AI_ASSISTED", "NOT_APPROVED"]);
    });
    const old = await ai.h.query.loadSummary(ai.recordId);
    expect(old.status === "READY" && old.snapshotStatus).toBe("SUPERSEDED");
    // No second AI action on an AI-assisted preview; approval is the patient's own, separate click.
    expect(screen.queryByRole("button", { name: messages.ai.careSummary.action })).toBeNull();
    expect(screen.queryByRole("button", { name: messages.careSummary.printAction })).toBeNull();
    expect(print.print).not.toHaveBeenCalled();
    await approveWhenPreviewed(messages.careSummary.approveAction);
    expect(await screen.findByRole("button", { name: messages.careSummary.printAction })).toBeTruthy();
    expect(print.print).not.toHaveBeenCalled();
    const approved = await ai.h.query.loadSummary(newId);
    expect(approved.status === "READY" && approved.snapshotStatus).toBe("APPROVED");
    // The approved AI-assisted summary keeps its AI label; the check notice is for review before approval.
    expect(screen.getByRole("region", { name: messages.ai.careSummary.resultTitle })).toBeTruthy();
    expect(screen.queryByText(messages.ai.careSummary.resultBody)).toBeNull();
  });

  it("a Cancel during the replacement command still shows the new preview (the replacement committed)", async () => {
    const ai = await activated();
    const gate: { release: () => void; started: boolean } = { release: () => undefined, started: false };
    const commands: CarePreparationCommandPort = {
      ...ai.commands,
      replaceWithAiAssistedPreview: async (input) => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
          gate.started = true;
        });
        return ai.commands.replaceWithAiAssistedPreview(input);
      },
    };
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: ai.h.query, commands }, audit: ai.audits, manifest: ENABLED_CARE_MANIFEST, requestClassGate: qualifiedTestRequestClassGate(), fetcher: ai.fetcher, now: () => LATER }).careSummary!;
    const onReplaced = vi.fn();
    renderAi(ai.h, ai.recordId, wording, { commands, onReplaced });
    fireEvent.click(await aiAction());
    // Packet 11C Addendum C (C3): this request's own acceptance (no session).
    fireEvent.click(within(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).getByRole("button", { name: en.ai.careSummary.confirm }));
    await waitFor(() => expect(gate.started).toBe(true));
    expect(ai.fetcher).toHaveBeenCalledTimes(1);
    expect((await ai.audits.list()).map((row) => row.outcomeCode)).toEqual(["ACCEPTED"]);
    fireEvent.click(screen.getByRole("button", { name: en.ai.cancel }));
    // Fix round 1: while the cancelled request's replacement command is still running, no second request can start and approval waits.
    expect(await screen.findByText(en.ai.cancelled)).toBeTruthy();
    const action = screen.getByRole("button", { name: en.ai.careSummary.action }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    fireEvent.click(action);
    expect((screen.getByRole("button", { name: en.careSummary.approveAction }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => undefined);
    expect(ai.fetcher).toHaveBeenCalledTimes(1);
    expect((await ai.audits.list()).map((row) => row.outcomeCode)).toEqual(["ACCEPTED"]);
    await act(async () => gate.release());
    expect(await screen.findByRole("region", { name: en.ai.careSummary.resultTitle })).toBeTruthy();
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(en.ai.cancelled)).toBeNull();
    expect(ai.fetcher).toHaveBeenCalledTimes(1);
  });

  it("a Cancel whose request then settles without a replacement lets a new request start (and only then)", async () => {
    const { h, recordId } = await prepared();
    const { port, calls } = fakeWording();
    renderAi(h, recordId, port);
    fireEvent.click(await aiAction());
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: en.ai.cancel }));
    const action = (await screen.findByRole("button", { name: en.ai.careSummary.action })) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    fireEvent.click(action);
    expect(port.compose).toHaveBeenCalledTimes(1);
    act(() => calls[0]!.resolve({ kind: "CANCELLED" }));
    await waitFor(() => expect(action.disabled).toBe(false));
    expect(screen.getByText(en.ai.cancelled)).toBeTruthy();
    fireEvent.click(action);
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(2));
  });

  it("until the NEW snapshot has loaded, the superseded preview still on screen is not actionable (no AI action, Approve disabled)", async () => {
    const { h, recordId } = await prepared();
    // A second, real snapshot stands in for the replacement; its load is held so the post-replacement window is observable.
    const next = await h.service.prepare(await h.selection());
    if (next.kind !== "COMMITTED") throw new Error(JSON.stringify(next));
    const held: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => (held.release = resolve));
    const query: CarePreparationQueryPort = {
      loadSummary: async (id) => {
        if (id === next.recordId) await gate;
        return h.query.loadSummary(id);
      },
    };
    const { port, calls } = fakeWording();
    const onReplaced = vi.fn();
    renderAi(h, recordId, port, { query, onReplaced });
    const before = (await screen.findByRole("article")).textContent;
    fireEvent.click(await aiAction());
    await waitFor(() => expect(port.compose).toHaveBeenCalledTimes(1));
    act(() => calls[0]!.resolve({ kind: "REPLACED", recordId: next.recordId }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith(next.recordId));
    await act(async () => undefined);
    // The old preview is still shown, but nothing on it can be acted on.
    expect(screen.getByRole("article").textContent).toBe(before);
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).toBeNull();
    expect((screen.getByRole("button", { name: en.careSummary.approveAction }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: en.careSummary.approveAction }));
    const old = await h.query.loadSummary(recordId);
    expect(old.status === "READY" && old.snapshotStatus).toBe("PREVIEWED");
    expect(port.compose).toHaveBeenCalledTimes(1);
    // Once the new snapshot has loaded it is the actionable preview.
    await act(async () => held.release());
    await waitFor(async () => {
      const view = await h.query.loadSummary(next.recordId);
      expect(view.status === "READY" && view.snapshotStatus).toBe("PREVIEWED");
    });
    await waitFor(() => expect((screen.getByRole("button", { name: en.careSummary.approveAction }) as HTMLButtonElement).disabled).toBe(false));
  });
});

/** The article's visible text for a payload: every printable line, headings without their markdown marker, no separators. */
function printableCareSummaryText(payload: Parameters<typeof printableCareSummary>[0]): string {
  return printableCareSummary(payload).lines.map((line) => line.text).join("");
}
