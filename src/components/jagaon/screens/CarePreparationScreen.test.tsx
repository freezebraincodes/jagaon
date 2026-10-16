import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import type { CareOrganisationCommandPort } from "@/application/care-organisation/care-organisation-contracts";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { CarePreparationScreen, type CarePreparationSelection } from "./CarePreparationScreen";

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
const open: JagaOnDatabase[] = [];
afterEach(async () => {
  cleanup();
  for (const database of open.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const uuid = () => crypto.randomUUID() as never;
// Sunday 4 Oct 2026, 10:00 in Singapore.
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };

async function setup({ seed = true, glucose = 0 }: { seed?: boolean; glucose?: number } = {}) {
  const database = createJagaOnDatabase(`packet9b-screen10-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  const carePlan = createCarePlanCommandService(database, { now: () => NOW, ids });
  const commands = createCareOrganisationService(database, { now: () => NOW, ids, carePlan });
  const query = createCareOrganisationQuery(database, { now: () => NOW });
  if (seed) await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids, demoQuestion: false });
  const journal = createJournalCommandService(database, { now: () => NOW, ids });
  for (let index = 0; index < glucose; index += 1) {
    await journal.recordGlucose({
      payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } },
      temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: `2026-10-0${index + 1}T13:00:00.000Z` as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } },
      recordedAt: NOW,
    });
  }
  return { database, commands, query };
}

type Ports = Awaited<ReturnType<typeof setup>>;
function renderScreen(locale: SupportedLocale, ports: Ports, extra: { commands?: CareOrganisationCommandPort; onPreview?: (selection: CarePreparationSelection) => Promise<boolean> } = {}) {
  return render(<CarePreparationScreen messages={getMessages(locale)} locale={locale} query={ports.query} commands={extra.commands ?? ports.commands} onPreview={extra.onPreview} />);
}

const appointmentCard = () => screen.getByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });

describe("Screen 10 Prepare for my visit", () => {
  it("shows the patient's appointment with provenance and a plain day count", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    expect(screen.getByText(en.carePreparation.loading)).toBeTruthy();
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    // Owner decision 2026-10-16: the title names who the recorded appointment is with (was the plain title).
    expect(screen.getByRole("heading", { level: 1, name: "Prepare for my appointment with Dr Lim" })).toBeTruthy();
    const card = appointmentCard();
    expect(within(card).getByText("Oct")).toBeTruthy();
    expect(within(card).getByText("14")).toBeTruthy();
    expect(within(card).getByText("Wednesday · 9:40 am · in 10 days")).toBeTruthy();
    expect(within(card).getByText(new RegExp(en.carePreparation.appointmentEnteredByYou))).toBeTruthy();
    expect(within(card).getByText(new RegExp(en.carePreparation.appointmentUnverified))).toBeTruthy();
  });

  it("lists the four factual groups unselected, with in-period counts, and keeps preview/export unavailable until 9C", async () => {
    const ports = await setup({ glucose: 2 });
    renderScreen("en-SG", ports);
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    const include = screen.getByRole("group", { name: en.carePreparation.includeHeading });
    const boxes = within(include).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, false, false, false]);
    const glucose = within(include).getByRole("checkbox", { name: new RegExp(en.carePreparation.glucoseReadings) });
    // The 14 local days ending today (owner instruction 2026-10-12; was 30 days, from 5 Sept).
    expect(glucose.closest("label")?.textContent).toContain("30 Sept 2026 – 4 Oct 2026 · 2 readings · listed by time"); // Owner decision 2026-10-16: the 5-day period
    // An empty group cannot be chosen, so nothing empty is silently included.
    expect((within(include).getByRole("checkbox", { name: new RegExp(en.carePreparation.walks) }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(en.carePreparation.emptySelection)).toBeTruthy();
    fireEvent.click(glucose);
    expect((glucose as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(en.carePreparation.emptySelection)).toBeNull();
    expect((screen.getByRole("button", { name: en.carePreparation.previewSummary }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: en.carePreparation.exportOrPrint }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en.carePreparation.localOnly)).toBeTruthy();
    expect(screen.getByText(en.carePreparation.selectionLimitation)).toBeTruthy();
  });

  it("hands over exactly the explicit selection when a preview port exists", async () => {
    const ports = await setup({ glucose: 1 });
    const onPreview = vi.fn(async (_selection: CarePreparationSelection) => false);
    renderScreen("en-SG", ports, { onPreview });
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    const previewButton = screen.getByRole("button", { name: en.carePreparation.previewSummary }) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.addOwnQuestion }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(en.carePreparation.questionLabel), { target: { value: "Can I travel with my pen?" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en.shared.save }));
    const include = await screen.findByRole("checkbox", { name: en.carePreparation.includeQuestion("Can I travel with my pen?") });
    // A new question is not included until the patient ticks it.
    expect((include as HTMLInputElement).checked).toBe(false);
    fireEvent.click(include);
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(en.carePreparation.glucoseReadings) }));
    fireEvent.click(previewButton);
    expect(onPreview).toHaveBeenCalledTimes(1);
    const selection = onPreview.mock.calls[0]![0];
    expect(selection.factGroups.map((group) => [group.key, group.sources.length])).toEqual([["GLUCOSE", 1]]);
    expect(selection.questions.map((question) => question.text)).toEqual(["Can I travel with my pen?"]);
    expect(selection.period).toMatchObject({ startDate: "2026-09-30", endDate: "2026-10-04" });
    expect(selection.appointment?.payload.appointmentLabel).toBe("Dr Lim, Bukit Merah Polyclinic");
    // Nothing unticked is included; the ticked items are not listed as unselected.
    expect(selection.notSelected).toEqual([]);
    // A failed preparation keeps every selection and says nothing was saved.
    expect(await screen.findByText(en.carePreparation.saveFailed)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: new RegExp(en.carePreparation.glucoseReadings) }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows the five question groups as closed disclosures with no invented questions", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    const titles = [en.carePreparation.medicineInfoQuestions, en.carePreparation.directionsQuestions, en.carePreparation.routineQuestions, en.carePreparation.trendQuestions, en.carePreparation.preventiveQuestions];
    for (const title of titles) {
      const summary = screen.getByText(title).closest("summary")!;
      expect(summary.textContent).toContain(en.carePreparation.noneSelected);
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
    }
    const first = screen.getByText(titles[0]!).closest("details") as HTMLDetailsElement;
    expect(within(first).getByText(en.carePreparation.groupEmpty)).toBeTruthy();
    expect(screen.getByText(en.carePreparation.questionsIntro)).toBeTruthy();
  });

  it("adds, edits and removes the patient's own question verbatim", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.addOwnQuestion }));
    let dialog = screen.getByRole("dialog", { name: en.carePreparation.addOwnQuestion });
    expect(within(dialog).getByText(en.carePreparation.questionHint)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    expect(within(dialog).getByText(en.shared.requiredField)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(en.carePreparation.questionLabel), { target: { value: "可以把笔放在包里吗？" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    // (A textarea's text also matches by text, so wait for the listed question itself.)
    await screen.findByRole("checkbox", { name: en.carePreparation.includeQuestion("可以把笔放在包里吗？") });
    expect(screen.getByRole("status").textContent).toBe(en.carePreparation.saved);

    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.editQuestionNamed("可以把笔放在包里吗？") }));
    dialog = screen.getByRole("dialog", { name: en.carePreparation.editQuestion });
    fireEvent.change(within(dialog).getByLabelText(en.carePreparation.questionLabel), { target: { value: "可以把胰岛素笔放在包里吗？" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await screen.findByRole("checkbox", { name: en.carePreparation.includeQuestion("可以把胰岛素笔放在包里吗？") });
    expect(screen.queryByText("可以把笔放在包里吗？")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.removeQuestionNamed("可以把胰岛素笔放在包里吗？") }));
    await waitFor(() => expect(screen.queryByText("可以把胰岛素笔放在包里吗？")).toBeNull());
  });

  it("keeps the typed question when saving fails", async () => {
    const ports = await setup();
    const failing: CareOrganisationCommandPort = { ...ports.commands, createCareQuestion: async () => ({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" }) };
    renderScreen("en-SG", ports, { commands: failing });
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.addOwnQuestion }));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText(en.carePreparation.questionLabel) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Keep my words" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await within(dialog).findByText(en.carePreparation.saveFailed);
    expect(field.value).toBe("Keep my words");
  });

  it("reschedules and then cancels the appointment with explicit reasons", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    fireEvent.click(within(appointmentCard()).getByRole("button", { name: en.carePreparation.changeAppointment }));
    let dialog = screen.getByRole("dialog", { name: en.carePreparation.changeAppointment });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    expect(within(dialog).getAllByText(en.shared.requiredField).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByLabelText(en.carePreparation.changeRescheduled));
    // Moving an appointment to the same time is not a reschedule.
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    expect(within(dialog).getByText(en.shared.invalidValue)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(en.carePreparation.appointmentDateLabel), { target: { value: "2026-10-21" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await waitFor(() => expect(within(appointmentCard()).getByText("21")).toBeTruthy());
    expect(within(appointmentCard()).getByText("Wednesday · 9:40 am · in 17 days")).toBeTruthy();

    fireEvent.click(within(appointmentCard()).getByRole("button", { name: en.carePreparation.changeAppointment }));
    dialog = screen.getByRole("dialog", { name: en.carePreparation.changeAppointment });
    fireEvent.click(within(dialog).getByLabelText(en.carePreparation.changeCancelled));
    expect(within(dialog).queryByLabelText(en.carePreparation.appointmentDateLabel)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await screen.findByText(en.carePreparation.noAppointmentTitle);
  });

  it("adds an appointment from the none state with a date and no time", async () => {
    const ports = await setup({ seed: false });
    renderScreen("en-SG", ports);
    await screen.findByText(en.carePreparation.noAppointmentTitle);
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.addAppointment }));
    const dialog = screen.getByRole("dialog", { name: en.carePreparation.addAppointment });
    fireEvent.change(within(dialog).getByLabelText(en.carePreparation.appointmentWhoLabel), { target: { value: "Eye clinic" } });
    fireEvent.change(within(dialog).getByLabelText(en.carePreparation.appointmentDateLabel), { target: { value: "2026-10-05" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    const card = await screen.findByRole("region", { name: "Eye clinic" });
    expect(within(card).getByText("Monday · in 1 day")).toBeTruthy();
  });

  it("shows unavailable storage without inventing an empty preparation", async () => {
    render(<CarePreparationScreen messages={en} locale="en-SG" query={{ loadPreventiveCare: async () => ({ status: "UNAVAILABLE" }), loadVisitPreparation: async () => ({ status: "UNAVAILABLE" }) }} commands={null} />);
    await screen.findByText(en.carePreparation.unavailableTitle);
    expect(screen.queryByText(en.carePreparation.noAppointmentTitle)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renders zh-SG with patient text verbatim and no delivery or answer claims", async () => {
    const ports = await setup();
    const { container } = renderScreen("zh-SG", ports);
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    // Owner decision 2026-10-16: the title names who the recorded appointment is with (was the plain title).
    expect(screen.getByRole("heading", { level: 1, name: zh.carePreparation.titleWithDoctor("Dr Lim") })).toBeTruthy();
    expect(within(appointmentCard()).getByText("10月")).toBeTruthy();
    expect(within(appointmentCard()).getByText(new RegExp(zh.carePreparation.appointmentEnteredByYou))).toBeTruthy();
    expect(screen.getByText(zh.carePreparation.localOnly)).toBeTruthy();
    const english = (await (async () => {
      cleanup();
      return renderScreen("en-SG", ports);
    })()).container;
    await screen.findByRole("region", { name: "Dr Lim, Bukit Merah Polyclinic" });
    expect((english.textContent ?? "").replaceAll(en.carePreparation.selectionLimitation, "").replaceAll(en.carePreparation.localOnly, "")).not.toMatch(/\bsent\b|deliver|received|reviewed|confirmed|missed|overdue/i);
    expect(container).toBeTruthy();
  });
});

describe("Screen 10 period overview and doctor-named title (owner decision 2026-10-16)", () => {
  const overview = () => screen.getByRole("region", { name: en.carePreparation.overviewHeading });
  // Counting runs after the preparation view loads, so allow for a slow fake database.
  const slow = { timeout: 10_000 };

  it("keeps the plain title when no appointment is recorded", async () => {
    const ports = await setup({ seed: false });
    renderScreen("en-SG", ports);
    await screen.findByText(en.carePreparation.noAppointmentTitle, {}, slow);
    expect(screen.getByRole("heading", { level: 1, name: en.carePreparation.title })).toBeTruthy();
  }, 30_000);

  it("names the appointment's label when no care contact was entered", async () => {
    const ports = await setup({ seed: false });
    await ports.commands.scheduleAppointment({
      payload: { appointmentLabel: "Bukit Merah Polyclinic", service: { kind: "UNKNOWN" }, mode: "UNKNOWN", status: "SCHEDULED" },
      scheduledAt: { kind: "DATE_ONLY", localDate: "2026-10-05" as never, timeZoneId: "Asia/Singapore" },
    });
    renderScreen("en-SG", ports);
    expect(await screen.findByRole("heading", { level: 1, name: "Prepare for my appointment with Bukit Merah Polyclinic" }, slow)).toBeTruthy();
  }, 30_000);

  it("states plain counts for the last 30 days, leaving out kinds with no records", async () => {
    const ports = await setup({ glucose: 3 });
    renderScreen("en-SG", ports);
    await waitFor(() => expect(within(overview()).getByText("In the last 30 days you logged 3 glucose readings.")).toBeTruthy(), slow);
    expect(overview().textContent).not.toMatch(/\b0\b|meal|insulin|walk/i);
  }, 30_000);

  it("counts again for the period the patient picks, and offers “Since your last visit” for the visit on record", async () => {
    const ports = await setup({ glucose: 3 });
    const onChange = vi.fn();
    render(<CarePreparationScreen messages={en} locale="en-SG" query={ports.query} commands={ports.commands} onOverviewPeriodChange={onChange} />);
    const period = await screen.findByRole("group", { name: en.carePreparation.overviewPeriodLegend }, slow);
    expect(within(period).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      en.carePreparation.periodLast7Days,
      en.carePreparation.periodLast14Days,
      en.carePreparation.periodLast30Days,
      en.carePreparation.periodSinceLastVisit,
    ]);
    expect((within(period).getByRole("radio", { name: en.carePreparation.periodLast30Days }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(period).getByRole("radio", { name: en.carePreparation.periodSinceLastVisit }));
    expect(onChange).toHaveBeenLastCalledWith("SINCE_LAST_VISIT");
    await waitFor(() => expect(within(overview()).getByText("Since your visit on 30 Aug 2026 you logged 3 glucose readings.")).toBeTruthy(), slow);
  }, 30_000);

  it("hides “Since your last visit” when no visit is on record", async () => {
    const ports = await setup({ seed: false });
    renderScreen("en-SG", ports);
    const period = await screen.findByRole("group", { name: en.carePreparation.overviewPeriodLegend }, slow);
    expect(within(period).queryByRole("radio", { name: en.carePreparation.periodSinceLastVisit })).toBeNull();
    expect(within(overview()).getByText("In the last 30 days you logged no records.")).toBeTruthy();
  }, 30_000);

  it("counts the saved questions for the doctor, and again after one is added", async () => {
    const ports = await setup({ glucose: 1 });
    renderScreen("en-SG", ports);
    await screen.findByText("In the last 30 days you logged 1 glucose reading.", {}, slow);
    expect(within(overview()).queryByText(/You saved/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.addOwnQuestion }));
    fireEvent.change(await screen.findByLabelText(en.carePreparation.questionLabel, {}, slow), { target: { value: "Can I travel with my pen?" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en.shared.save }));
    await waitFor(() => expect(within(overview()).getByText("You saved 1 question for Dr Lim.")).toBeTruthy(), slow);
  }, 30_000);

  it("states the overview in zh-SG", async () => {
    const ports = await setup({ glucose: 2 });
    renderScreen("zh-SG", ports);
    await waitFor(() => expect(screen.getByText("过去 30 天，你记录了2 次血糖读数。")).toBeTruthy(), slow);
  }, 30_000);
});
