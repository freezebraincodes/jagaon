import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import type { RecordHead, RecordId } from "@/domain/shared";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact } from "@/application/care-preparation/care-preparation-test-support";
import type { CarePreparationCommandPort } from "@/application/care-preparation/care-preparation-contracts";
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

async function noticeRegion(locale: SupportedLocale = "en-SG") {
  return screen.findByRole("region", { name: getMessages(locale).careSummary.draftNotices.label });
}

const noticeTexts = (region: HTMLElement) => within(region).getAllByRole("paragraph").map((paragraph) => paragraph.textContent);

describe("Care-summary preview: Packet 11C appointment preview (A3)", () => {
  it("renders the fixed care-draft notices after “About this summary”, as a separate labelled region outside the printed summary", async () => {
    const { h, recordId } = await prepared();
    renderPreview(h, recordId);
    const article = await screen.findByRole("article");
    const region = await noticeRegion();
    // The limitation section is the article's last section, and the notices follow the article rather than sit inside it.
    const headings = within(article).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe(en.careSummary.limitationsHeading);
    expect(article.contains(region)).toBe(false);
    expect(article.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(noticeTexts(region)).toEqual([en.careSummary.draftNotices.questions, en.careSummary.draftNotices.draft]);
    // Not part of the limitation list, and not part of the approved, hashed print content.
    for (const text of noticeTexts(region)) expect(article.textContent).not.toContain(text);
  });

  it("shows the questions notice only when the summary has a questions section", async () => {
    const { h, recordId } = await prepared("en-SG", { questions: false });
    renderPreview(h, recordId);
    const article = await screen.findByRole("article");
    expect(within(article).queryByRole("heading", { name: en.careSummary.questionsHeading })).toBeNull();
    expect(noticeTexts(await noticeRegion())).toEqual([en.careSummary.draftNotices.draft]);
  });

  it("keeps approval a separate click with its meaning visible, and print reachable only after approval", async () => {
    const { h, recordId } = await prepared();
    renderPreview(h, recordId);
    await noticeRegion();
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
    expect(noticeTexts(await noticeRegion())).toEqual([en.careSummary.draftNotices.questions, en.careSummary.draftNotices.draft]);
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`offers no send, share or email action and makes no review or delivery claim outside the notices' negated sentences (${locale})`, async () => {
      const { h, recordId } = await prepared(locale);
      const { container } = renderPreview(h, recordId, { locale });
      const messages = getMessages(locale).careSummary;
      const region = await noticeRegion(locale);
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
      expect(container.textContent).toContain(messages.draftNotices.draft);
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
    await noticeRegion();
    expect(within(article).getByText("3 Oct 2026, 9:00 pm · 6.6 mmol/L")).toBeTruthy();
    expect(within(article).getByText("Selected question words")).toBeTruthy();
    expect(container.textContent).not.toContain("9.4");
    expect(container.textContent).not.toContain("Unselected question words");
  });
});

describe("Care-summary preview: care-draft notices are the approved copy, verbatim", () => {
  // The i18n strings careSummary.draftNotices.{questions,draft} are a verbatim copy of the approved care-draft notices
  // (AI_LANGUAGE_COPY.careDraftNotices, ai-language-copy.11b.10, unchanged since 11b.8); pinned by this test; do not edit independently.
  // The screen cannot import the approved renderer (packet-11a-manifest / packet-9c-manifest browser-graph boundary), so this
  // test, which is not in the browser graph, holds both sides equal byte for byte.
  it("keeps the i18n strings byte-identical to the approved notice copy", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const notices = getMessages(locale).careSummary.draftNotices;
      expect([notices.questions, notices.draft], locale).toEqual([AI_LANGUAGE_COPY.careDraftNotices.questions[locale], AI_LANGUAGE_COPY.careDraftNotices.draft[locale]]);
    }
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    for (const questions of [true, false]) {
      it(`renders exactly the approved renderer's notices (${locale}, ${questions ? "with" : "without"} a questions section)`, async () => {
        const { h, recordId } = await prepared(locale, { questions });
        renderPreview(h, recordId, { locale });
        const rendered = noticeTexts(await noticeRegion(locale));
        const view = await h.query.loadSummary(recordId);
        if (view.status !== "READY") throw new Error("ready");
        expect(view.payload.sections.some((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM")).toBe(questions);
        const approved = approvedNoticeTexts(view.payload);
        expect(approved).toHaveLength(questions ? 2 : 1);
        expect(rendered).toEqual(approved);
        for (const [index, text] of approved.entries()) expect(Buffer.from(rendered[index] ?? "", "utf8").equals(Buffer.from(text, "utf8"))).toBe(true);
      });
    }
  }
});
