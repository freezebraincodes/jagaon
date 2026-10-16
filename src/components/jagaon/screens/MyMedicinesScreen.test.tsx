import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import type { DemoOnboardingSaveResult } from "@/application/onboarding/demo-onboarding-repository";
import { MyMedicinesScreen, type MyMedicinesView } from "./MyMedicinesScreen";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const prepared = createPreparedOnboardingState("en-SG", "2026-10-02T08:00:00.000Z");
const NEW_ID = "66666666-6666-4666-8666-666666666666";

function renderScreen(options: {
  state?: DemoOnboardingStateV1;
  view?: MyMedicinesView;
  medicineId?: string;
  save?: (next: DemoOnboardingStateV1) => DemoOnboardingSaveResult;
} = {}) {
  const save = vi.fn(options.save ?? ((next: DemoOnboardingStateV1) => ({ ok: true as const, state: next })));
  const navigate = vi.fn();
  const showView = vi.fn();
  render(
    <MyMedicinesScreen
      messages={en}
      locale="en-SG"
      state={options.state ?? prepared}
      view={options.view ?? "list"}
      medicineId={options.medicineId}
      save={save}
      navigate={navigate}
      showView={showView}
      createId={() => NEW_ID}
    />,
  );
  return { save, navigate, showView };
}

describe("MyMedicinesScreen", () => {
  it("manages the setup list without the progress indicator or setup-only actions", () => {
    const { navigate, showView } = renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: en.medication.screenTitle })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shared.continue })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.onboarding.skipMedicines })).not.toBeInTheDocument();
    expect(screen.getByText("Lantus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.addAnother }));
    expect(showView).toHaveBeenCalledWith("add");
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.editNamed("Apidra") }));
    expect(showView).toHaveBeenCalledWith("directions", prepared.medicines[1]!.id);
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.medicineInformationLink }));
    expect(navigate).toHaveBeenCalledWith("MEDICATION_INFORMATION");
  });

  it("removes a medicine only after confirmation", () => {
    const { save } = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.removeNamed("Lantus") }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.removeMedicine }));
    expect(save.mock.calls[0]![0].medicines.map((m) => m.displayName)).toEqual(["Apidra"]);
  });

  it("adds a medicine and opens its directions; adding after a skip completes setup", () => {
    const skipped: DemoOnboardingStateV1 = { ...prepared, status: "SKIPPED", medicines: [] };
    const { save, showView } = renderScreen({ state: skipped, view: "add" });
    fireEvent.click(screen.getByRole("radio", { name: /Glucotab/ }));
    fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
    const saved = save.mock.calls[0]![0];
    expect(saved.status).toBe("COMPLETED");
    expect(saved.medicines[0]).toMatchObject({ id: NEW_ID, displayName: "Glucotab", reviewedContentKey: null });
    expect(showView).toHaveBeenCalledWith("directions", NEW_ID);
  });

  it("saves edited directions verbatim and returns to the list", () => {
    const target = prepared.medicines[0]!;
    const { save, showView } = renderScreen({ view: "directions", medicineId: target.id });
    const field = screen.getByRole("textbox", { name: `${en.onboarding.fieldDirections} (${en.shared.optional})` });
    expect(field).toHaveValue(target.verbatimDirections);
    fireEvent.change(field, { target: { value: "Inject 10 units at night (demo label)" } });
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.saveRecorded }));
    expect(save.mock.calls[0]![0].medicines[0]!.verbatimDirections).toBe("Inject 10 units at night (demo label)");
    expect(showView).toHaveBeenCalledWith("list");
  });

  it("keeps the edit in memory on a failed save and retries it exactly", () => {
    let fail = true;
    const { save, showView } = renderScreen({
      view: "directions",
      medicineId: prepared.medicines[0]!.id,
      save: (next) => (fail ? { ok: false, reason: "STORAGE_UNAVAILABLE" } : { ok: true, state: next }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: `${en.onboarding.fieldAmount} (${en.shared.optional})` }), {
      target: { value: "10 units" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.saveRecorded }));
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.failureTitle })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en.onboarding.failureStatus);
    expect(showView).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.tryAgain }));
    expect(save.mock.calls[1]![0]).toEqual(save.mock.calls[0]![0]);
    expect(save.mock.calls[1]![0].medicines[0]!.amountAndUnit).toBe("10 units");
    expect(showView).toHaveBeenCalledWith("list");
  });

  it("shows the empty list for a skipped setup", () => {
    renderScreen({ state: { ...prepared, status: "SKIPPED", medicines: [] } });
    expect(screen.getByText(en.onboarding.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.onboarding.medicineInformationLink })).not.toBeInTheDocument();
  });
});
