import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import type { RecordHead, RecordId } from "@/domain/shared";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact } from "@/application/care-preparation/care-preparation-test-support";
import type { CarePreparationCommandPort } from "@/application/care-preparation/care-preparation-contracts";
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

async function prepared(locale: SupportedLocale = "en-SG") {
  const h = await createCarePreparationHarness();
  const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  if (reading.kind !== "COMMITTED") throw new Error("reading");
  const question = await h.organisation.createCareQuestion({ questionText: { text: "可以把笔放在包里吗？", language: "zh-SG" } });
  if (question.kind !== "COMMITTED") throw new Error("question");
  const result = await h.service.prepare({ ...(await h.selection()), locale });
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
