import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { persistedWithMedicine, renderFlow } from "./test-harness";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const heading = (name: string) => screen.getByRole("heading", { level: 1, name });

describe("frame 22 — required medicine name", () => {
  it("names the field, alerts, moves focus and does not advance", () => {
    const { saves } = renderFlow();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    const before = saves.length;
    click(en.shared.continue);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(en.onboarding.nameRequired);
    const input = screen.getByLabelText(en.onboarding.medicineNameLabel);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect(input).toHaveFocus();
    expect(saves).toHaveLength(before);
    expect(heading(en.onboarding.selectTitle)).toBeInTheDocument();

    // Choosing "Medicine not listed" without a name still keeps the error path.
    fireEvent.click(screen.getByRole("radio", { name: /Medicine not listed/ }));
    click(en.shared.continue);
    expect(screen.getByRole("alert")).toHaveTextContent(en.onboarding.nameRequired);

    fireEvent.click(screen.getByRole("radio", { name: /Lantus/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    click(en.shared.continue);
    expect(heading(en.onboarding.directionsTitle)).toBeInTheDocument();
  });
});

describe("frame 25 — removal confirmation", () => {
  function toList() {
    const store = renderFlow({ initial: { ...persistedWithMedicine, lastCompletedStep: "PROFILE" } });
    click(en.onboarding.continueFromStep(2));
    return store;
  }

  it("opens an alert dialog on the safe action and cancels with Escape back to the card", () => {
    const { saves } = toList();
    const remove = screen.getByRole("button", { name: en.onboarding.removeNamed("Lantus") });
    fireEvent.click(remove);
    const dialog = screen.getByRole("alertdialog", { name: en.onboarding.removeTitle });
    expect(dialog).toHaveTextContent(en.onboarding.removeBody("Lantus"));
    expect(within(dialog).getByRole("button", { name: en.onboarding.keepIt })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(remove).toHaveFocus();
    expect(saves).toHaveLength(0);
  });

  it("removes only after confirmation and shows the empty list", () => {
    const { saves } = toList();
    click(en.onboarding.removeNamed("Lantus"));
    click(en.onboarding.removeMedicine);
    expect(saves.at(-1)!.medicines).toEqual([]);
    expect(screen.getByText(en.onboarding.emptyTitle)).toBeInTheDocument();
  });
});

describe("frames 26 and 30 — resume and restart", () => {
  it("lists only persisted values and labels the next step as not yet saved", () => {
    renderFlow({ initial: persistedWithMedicine });
    expect(heading(en.onboarding.resumeTitle)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.resumeBody(4, en.onboarding.stepDirections))).toBeInTheDocument();
    const kept = screen.getByRole("region", { name: en.onboarding.kept });
    expect(kept).toHaveTextContent("Preferred name: Mdm Tan");
    expect(kept).toHaveTextContent("1 medicine: Lantus");
    expect(screen.getByText(en.onboarding.continueAtStep(en.onboarding.directionsFor("Lantus"), 4))).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(en.onboarding.resumedAnnouncement);
    click(en.onboarding.continueFromStep(4));
    expect(heading(en.onboarding.directionsTitle)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: en.insulin.medicineLabel })).toHaveTextContent("Lantus");
  });

  it("restart confirmation traps focus, cancels with Escape and returns focus", () => {
    const { storage } = renderFlow({ initial: persistedWithMedicine });
    const start = screen.getByRole("button", { name: en.onboarding.startAgain });
    fireEvent.click(start);
    const dialog = screen.getByRole("alertdialog", { name: en.onboarding.restartTitle });
    const keep = within(dialog).getByRole("button", { name: en.onboarding.keepProgress });
    const confirm = within(dialog).getByRole("button", { name: en.onboarding.confirmRestart });
    expect(keep).toHaveFocus();
    expect(dialog).toHaveTextContent(en.onboarding.restartBody("preferred name and 1 medicine"));
    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(start).toHaveFocus();
    expect(storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull(); // nothing written by cancel
  });

  it("confirming restart clears only the onboarding key and opens Step 1", () => {
    const { storage } = renderFlow({
      initial: persistedWithMedicine,
      storage: {
        [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(persistedWithMedicine),
        "jagaon:unrelated": "keep",
      },
    });
    click(en.onboarding.startAgain);
    click(en.onboarding.confirmRestart);
    expect(storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(storage.getItem("jagaon:unrelated")).toBe("keep");
    expect(heading(en.onboarding.profileTitle)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByLabelText(/Preferred name/)).toHaveValue("");
  });
});

describe("frame 28 — local-storage failure", () => {
  it("does not advance or claim success, then retries the exact same write", () => {
    const { saves, attempts } = renderFlow({ failWrites: 1 });
    click(en.onboarding.startSetup);
    fireEvent.change(screen.getByLabelText(/Preferred name/), { target: { value: "Mdm Tan" } });
    click(en.shared.continue);

    expect(heading(en.onboarding.failureTitle)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en.onboarding.failureStatus);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(en.onboarding.savedAnnouncement)).not.toBeInTheDocument();
    expect(saves).toHaveLength(0);

    click(en.onboarding.tryAgain);
    expect(saves).toHaveLength(1);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(saves[0]!.preferredName).toBe("Mdm Tan");
    expect(heading(en.onboarding.medicinesTitle)).toBeInTheDocument();
  });

  it("keeps failing safely and returning to welcome discards only the unsaved delta", () => {
    const { saves, storage } = renderFlow({ failWrites: 3 });
    click(en.onboarding.startSetup);
    fireEvent.change(screen.getByLabelText(/Preferred name/), { target: { value: "Unsaved name" } });
    click(en.shared.continue);
    click(en.onboarding.tryAgain);
    expect(heading(en.onboarding.failureTitle)).toBeInTheDocument();
    click(en.onboarding.returnWelcome);
    expect(heading(en.onboarding.welcomeTitle)).toBeInTheDocument();
    click(en.onboarding.startSetup);
    expect(screen.getByLabelText(/Preferred name/)).toHaveValue("");
    expect(saves).toHaveLength(0);
    expect(storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("retains entered directions in memory through a failed save", () => {
    const { saves, failNext } = renderFlow({ initial: persistedWithMedicine });
    click(en.onboarding.continueFromStep(4));
    fireEvent.change(screen.getByRole("textbox", { name: `${en.onboarding.fieldDirections} (${en.shared.optional})` }), {
      target: { value: "Inject 12 units every night at 9 pm (demo label)" },
    });
    failNext(1);
    click(en.onboarding.saveRecorded);
    expect(heading(en.onboarding.failureTitle)).toBeInTheDocument();
    click(en.onboarding.tryAgain);
    expect(saves.at(-1)!.medicines[0]!.verbatimDirections).toBe("Inject 12 units every night at 9 pm (demo label)");
    expect(heading(en.onboarding.reviewTitle)).toBeInTheDocument();
  });
});

// Owner decision 2026-10-16: the English-only demo hides the language choice during setup; re-enable with it.
describe.skip("frame 29 — language switched mid-setup", () => {
  it("persists the switch, announces it in the new language and keeps typed values verbatim", () => {
    const { saves } = renderFlow();
    click(en.onboarding.startSetup);
    fireEvent.change(screen.getByLabelText(/Preferred name/), { target: { value: "Mdm Tan" } });
    fireEvent.click(screen.getByRole("radio", { name: en.settings.chinese }));
    expect(saves.at(-1)).toMatchObject({ locale: "zh-SG", preferredName: "Mdm Tan", status: "IN_PROGRESS" });
    expect(heading(zh.onboarding.profileTitle)).toBeInTheDocument();
    // Visible confirmation (frame 29) plus the polite live announcement.
    expect(screen.getAllByText(zh.onboarding.languageSwitched(zh.settings.chinese))).toHaveLength(2);
    expect(screen.getByText(zh.onboarding.notTranslated)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(zh.onboarding.languageSwitched(zh.settings.chinese));
    expect(screen.getByLabelText(/称呼/)).toHaveValue("Mdm Tan");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  });

  it("keeps a recorded medicine name and directions untranslated after switching", () => {
    renderFlow({
      initial: {
        ...persistedWithMedicine,
        lastCompletedStep: "DIRECTIONS",
        medicines: [{ ...persistedWithMedicine.medicines[0]!, verbatimDirections: "Inject 12 units every night" }],
      },
    });
    click(en.onboarding.continueFromStep(5));
    click(en.onboarding.editNamed(en.onboarding.aboutYou));
    fireEvent.click(screen.getByRole("radio", { name: en.settings.chinese }));
    click(zh.shared.continue);
    click(zh.shared.continue);
    expect(screen.getByText("Lantus")).toBeInTheDocument();
    expect(screen.getByText("Inject 12 units every night")).toBeInTheDocument();
  });
});

describe("frame 27 — explicit skip", () => {
  it("skips from Step 1, writes SKIPPED and never blocks Today", () => {
    const { saves, onExit } = renderFlow();
    click(en.onboarding.startSetup);
    click(en.onboarding.skipForNow);
    expect(saves.at(-1)!.status).toBe("SKIPPED");
    expect(heading(en.onboarding.skippedTitle)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    click(en.onboarding.openToday);
    expect(onExit).toHaveBeenCalledWith({ state: saves.at(-1), destination: "TODAY" });
  });

  it("skips medicine setup from the empty list and can add a medicine now", () => {
    const { saves, onExit } = renderFlow();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    expect(screen.getByText(en.onboarding.skipMedicinesNote)).toBeInTheDocument();
    click(en.onboarding.skipMedicines);
    expect(saves.at(-1)).toMatchObject({ status: "SKIPPED", medicines: [] });
    click(en.onboarding.addMedicineNow);
    expect(onExit).toHaveBeenCalledWith({ state: saves.at(-1), destination: "MY_MEDICINES_ADD" });
  });
});
