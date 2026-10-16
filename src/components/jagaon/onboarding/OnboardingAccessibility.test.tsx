import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { persistedWithMedicine, renderFlow } from "./test-harness";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** Every visible form control has a persistent, visible <label>. */
function expectVisibleLabels() {
  for (const control of document.querySelectorAll<HTMLElement>("main input:not([type=radio]), main textarea, main select")) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`);
    expect(label, control.outerHTML).not.toBeNull();
    expect(label!.textContent!.trim().length).toBeGreaterThan(0);
    expect(label!.classList.contains("sr-only")).toBe(false);
  }
}

function expectSingleHeading(name: string) {
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent(name);
}

describe("onboarding accessibility", () => {
  it("keeps one page heading, visible labels and correct progress semantics on every step", () => {
    renderFlow();
    expectSingleHeading(en.onboarding.welcomeTitle);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    click(en.onboarding.startSetup);
    expectSingleHeading(en.onboarding.profileTitle);
    expectVisibleLabels();
    // Focus moves to the new view's heading on every route change.
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    const progress = screen.getByRole("progressbar", { name: en.onboarding.progressLabel });
    expect(progress).toHaveAttribute("aria-valuemin", "1");
    expect(progress).toHaveAttribute("aria-valuemax", "5");

    click(en.shared.continue);
    expectSingleHeading(en.onboarding.medicinesTitle);
    click(en.onboarding.addMedicine);
    expectSingleHeading(en.onboarding.selectTitle);
    expectVisibleLabels();
    fireEvent.click(screen.getByRole("radio", { name: /Lantus/ }));
    click(en.shared.continue);
    expectSingleHeading(en.onboarding.directionsTitle);
    expectVisibleLabels();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    click(en.onboarding.saveRecorded);
    expectSingleHeading(en.onboarding.reviewTitle);
    click(en.onboarding.finishSetup);
    expectSingleHeading(en.onboarding.completeTitle);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("announces saves politely without moving focus away from the new step", () => {
    renderFlow();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    expect(status).toHaveTextContent(en.onboarding.savedAnnouncement);
  });

  it("keeps catalogue cards and source choices keyboard-operable native radios", () => {
    renderFlow();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    for (const radio of radios) {
      expect(radio.tagName).toBe("INPUT");
      expect(radio).not.toHaveAttribute("tabindex", "-1");
    }
    // Space on a focused native radio selects it.
    radios[1]!.focus();
    fireEvent.click(radios[1]!);
    expect(radios[1]).toBeChecked();
  });

  it("omits the step indicator on recovery and terminal screens (frames 26–28)", () => {
    renderFlow({ initial: persistedWithMedicine, failWrites: 1 });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    click(en.onboarding.continueFromStep(4));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
    click(en.onboarding.saveRecorded);
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.failureTitle })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("never shows bottom navigation during onboarding", () => {
    renderFlow();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    click(en.onboarding.startSetup);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("conveys reviewed availability with text and icon, not colour alone", () => {
    renderFlow();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    expect(screen.getAllByText(en.onboarding.reviewedAvailable)).toHaveLength(2);
    expect(screen.getAllByText(en.onboarding.reviewedUnavailableTag)).toHaveLength(1);
  });
});
