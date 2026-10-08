import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import type { RecordHead, RecordId } from "@/domain/shared";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact, rewriteAsLegacy9c1Snapshot } from "@/application/care-preparation/care-preparation-test-support";
import type { CarePreparationCommandPort } from "@/application/care-preparation/care-preparation-contracts";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import type { AiTaskRequest } from "@/domain/ai";
import { renderCareDraftNotices } from "@/application/ai/language/care-draft-notices";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import type { PrintPort } from "../care-preparation/PrintPort";
import { CareSummaryPreviewScreen } from "./CareSummaryPreviewScreen";

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

/** The article's visible text for a payload: every printable line, headings without their markdown marker, no separators. */
function printableCareSummaryText(payload: Parameters<typeof printableCareSummary>[0]): string {
  return printableCareSummary(payload).lines.map((line) => line.text).join("");
}
