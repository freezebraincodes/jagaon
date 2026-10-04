import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import type { CareOrganisationCommandPort } from "@/application/care-organisation/care-organisation-contracts";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { PreventiveCareScreen } from "./PreventiveCareScreen";

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
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };

async function setup({ seed = true }: { seed?: boolean } = {}) {
  const database = createJagaOnDatabase(`packet9b-screen09-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  const carePlan = createCarePlanCommandService(database, { now: () => NOW, ids });
  const commands = createCareOrganisationService(database, { now: () => NOW, ids, carePlan });
  const query = createCareOrganisationQuery(database, { now: () => NOW });
  if (seed) await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids });
  return { database, commands, query };
}

function renderScreen(locale: SupportedLocale, ports: Awaited<ReturnType<typeof setup>>, commands: CareOrganisationCommandPort = ports.commands) {
  return render(<PreventiveCareScreen messages={getMessages(locale)} locale={locale} query={ports.query} commands={commands} />);
}

const cards = () => screen.getAllByRole("article");
const cardFor = (name: string) => cards().find((card) => within(card).queryByRole("heading", { name }))!;

describe("Screen 09 My health checks", () => {
  it("shows the four patient-maintained items with their entered dates, notes, source and text status", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    expect(screen.getByText(en.preventiveCare.loading)).toBeTruthy();
    await screen.findByRole("heading", { name: "Eye screening" });
    expect(screen.getByRole("heading", { level: 1, name: en.preventiveCare.title })).toBeTruthy();
    expect(screen.getByText(en.preventiveCare.maintainedByYou)).toBeTruthy();
    expect(cards().map((card) => within(card).getByRole("heading").textContent)).toEqual(["Eye screening", "Blood test", "Foot check", "Flu vaccine"]);

    const eye = cardFor("Eye screening");
    expect(within(eye).getByText(en.preventiveCare.statusScheduled)).toBeTruthy();
    expect(within(eye).getByText("3 Nov 2026")).toBeTruthy();
    expect(within(eye).getByText("Afternoon slot")).toBeTruthy();
    expect(within(eye).getByText("Appointment letter, 2 Sep 2026")).toBeTruthy();

    const foot = cardFor("Foot check");
    expect(within(foot).getByText(en.preventiveCare.statusRecorded)).toBeTruthy();
    // en-SG abbreviates September as "Sept".
    expect(within(foot).getByText("14 Sept 2026")).toBeTruthy();
    expect(within(foot).getByRole("button", { name: `${en.preventiveCare.undoRecorded}: Foot check` })).toBeTruthy();

    const flu = cardFor("Flu vaccine");
    expect(within(flu).getAllByText(en.preventiveCare.statusNoDate).length).toBeGreaterThan(0);
    expect(within(flu).getByText("Want to ask the clinic")).toBeTruthy();
  });

  it("keeps general information in a separate labelled region that is not an assessment and claims no review", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("heading", { name: "Eye screening" });
    const general = screen.getByRole("region", { name: en.preventiveCare.generalHeading });
    // No reviewed content asset exists yet, so nothing claims to be reviewed.
    expect(within(general).queryByText(en.preventiveCare.reviewedTag)).toBeNull();
    expect(within(general).queryByText(en.preventiveCare.generalIntro)).toBeNull();
    for (const title of [en.preventiveCare.topicEyeTitle, en.preventiveCare.topicVaccinationTitle, en.preventiveCare.topicLifestyleTitle, en.preventiveCare.topicFollowUpTitle]) {
      expect(within(general).getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(within(general).getAllByText(en.preventiveCare.generalNotAssessment)).toHaveLength(4);
    // Personal records never sit inside the general region.
    expect(within(general).queryByText("Afternoon slot")).toBeNull();
    expect(screen.getByText(en.preventiveCare.recordLimitation)).toBeTruthy();
  });

  it("never shows due, overdue, eligibility, missed or completion wording", async () => {
    const ports = await setup();
    const { container } = renderScreen("en-SG", ports);
    await screen.findByRole("heading", { name: "Eye screening" });
    const visible = (container.textContent ?? "").replaceAll(en.preventiveCare.maintainedByYou, "").replaceAll(en.preventiveCare.recordLimitation, "").replaceAll(en.preventiveCare.generalNotAssessment, "");
    expect(visible).not.toMatch(/overdue|eligib|missed|completed|recommended|\bdue\b/i);
  });

  it("marks an item as recorded with the patient's date, then undoes it", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("heading", { name: "Blood test" });
    fireEvent.click(within(cardFor("Blood test")).getByRole("button", { name: `${en.preventiveCare.markRecorded}: Blood test` }));
    const dialog = screen.getByRole("dialog", { name: en.preventiveCare.markRecorded });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    expect(within(dialog).getByText(en.shared.requiredField)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(en.preventiveCare.dateEntered), { target: { value: "2026-10-03" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(cardFor("Blood test")).getByText(en.preventiveCare.statusRecorded)).toBeTruthy());
    expect(within(cardFor("Blood test")).getByText("3 Oct 2026")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(en.preventiveCare.saved);

    fireEvent.click(within(cardFor("Blood test")).getByRole("button", { name: `${en.preventiveCare.undoRecorded}: Blood test` }));
    await waitFor(() => expect(within(cardFor("Blood test")).getByText(en.preventiveCare.statusScheduled)).toBeTruthy());
    expect(within(cardFor("Blood test")).getByText("14 Oct 2026")).toBeTruthy();
  });

  it("corrects an item's date and note and shows the history", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("heading", { name: "Flu vaccine" });
    fireEvent.click(within(cardFor("Flu vaccine")).getByRole("button", { name: `${en.preventiveCare.edit}: Flu vaccine` }));
    const dialog = screen.getByRole("dialog", { name: en.preventiveCare.edit });
    // A reviewed catalogue item keeps its name.
    expect(within(dialog).queryByLabelText(en.preventiveCare.itemNameLabel)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(`${en.preventiveCare.dateEntered} (${en.shared.optional})`), { target: { value: "2026-11-20" } });
    fireEvent.change(within(dialog).getByLabelText(`${en.preventiveCare.note} (${en.shared.optional})`), { target: { value: "Clinic said November" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await waitFor(() => expect(within(cardFor("Flu vaccine")).getByText("20 Nov 2026")).toBeTruthy());
    expect(within(cardFor("Flu vaccine")).getByText("Clinic said November")).toBeTruthy();

    fireEvent.click(within(cardFor("Flu vaccine")).getByRole("button", { name: `${en.preventiveCare.history}: Flu vaccine` }));
    const history = screen.getByRole("dialog", { name: en.preventiveCare.history });
    const entries = within(history).getAllByRole("listitem");
    expect(entries.map((entry) => entry.querySelector(".care-history-action")?.textContent)).toEqual([en.preventiveCare.historyEntered, en.preventiveCare.historyCorrected]);
    fireEvent.click(within(history).getByRole("button", { name: en.shared.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a patient-defined item", async () => {
    const ports = await setup();
    renderScreen("en-SG", ports);
    await screen.findByRole("heading", { name: "Eye screening" });
    fireEvent.click(screen.getByRole("button", { name: en.preventiveCare.addItem }));
    const dialog = screen.getByRole("dialog", { name: en.preventiveCare.addItem });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    expect(within(dialog).getByText(en.shared.requiredField)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(en.preventiveCare.itemNameLabel), { target: { value: "Dental check 牙齿" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await screen.findByRole("heading", { name: "Dental check 牙齿" });
    expect(within(cardFor("Dental check 牙齿")).getAllByText(en.preventiveCare.statusNoDate).length).toBeGreaterThan(0);
  });

  it("keeps the dialog values and says nothing was saved when storage fails", async () => {
    const ports = await setup();
    const failing: CareOrganisationCommandPort = { ...ports.commands, revisePreventiveItem: async () => ({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" }) };
    renderScreen("en-SG", ports, failing);
    await screen.findByRole("heading", { name: "Flu vaccine" });
    fireEvent.click(within(cardFor("Flu vaccine")).getByRole("button", { name: `${en.preventiveCare.edit}: Flu vaccine` }));
    const dialog = screen.getByRole("dialog", { name: en.preventiveCare.edit });
    const note = within(dialog).getByLabelText(`${en.preventiveCare.note} (${en.shared.optional})`) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Keep this" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.save }));
    await within(dialog).findByText(en.preventiveCare.saveFailed);
    expect(note.value).toBe("Keep this");
    expect(within(cardFor("Flu vaccine")).queryByText("Keep this")).toBeNull();
  });

  it("shows the empty state with Add an item", async () => {
    const ports = await setup({ seed: false });
    renderScreen("en-SG", ports);
    await screen.findByText(en.preventiveCare.emptyTitle);
    expect(screen.getByText(en.preventiveCare.emptyBody)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.preventiveCare.addItem })).toBeTruthy();
    expect(screen.getByRole("region", { name: en.preventiveCare.generalHeading })).toBeTruthy();
  });

  it("shows unavailable storage without inventing an empty list", async () => {
    render(<PreventiveCareScreen messages={en} locale="en-SG" query={{ loadPreventiveCare: async () => ({ status: "UNAVAILABLE" }), loadVisitPreparation: async () => ({ status: "UNAVAILABLE" }) }} commands={null} />);
    await screen.findByText(en.preventiveCare.unavailableTitle);
    expect(screen.queryByText(en.preventiveCare.emptyTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: en.preventiveCare.addItem })).toBeNull();
  });

  it("renders the zh-SG frame with catalogue labels in Chinese and patient text verbatim", async () => {
    const ports = await setup();
    renderScreen("zh-SG", ports);
    await screen.findByRole("heading", { name: "眼睛检查" });
    expect(screen.getByRole("heading", { level: 1, name: zh.preventiveCare.title })).toBeTruthy();
    expect(within(cardFor("眼睛检查")).getByText(zh.preventiveCare.statusScheduled)).toBeTruthy();
    expect(within(cardFor("眼睛检查")).getByText("Afternoon slot")).toBeTruthy();
    expect(within(cardFor("眼睛检查")).getByText("2026年11月3日")).toBeTruthy();
    expect(screen.getByRole("region", { name: zh.preventiveCare.generalHeading })).toBeTruthy();
  });
});
