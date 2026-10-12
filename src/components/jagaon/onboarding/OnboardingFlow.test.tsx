import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import {
  createDemoOnboardingRepository,
  createMemoryOnboardingStorage,
  DEMO_ONBOARDING_STORAGE_KEY,
  type DemoOnboardingRepository,
} from "@/application/onboarding/demo-onboarding-repository";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import { OnboardingFlow, type OnboardingExit } from "./OnboardingFlow";
import { ReviewStep } from "./ReviewStep";
import { MedicineListStep } from "./MedicineListStep";
import { persistedWithMedicine } from "./test-harness";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const NOW = "2026-10-02T08:00:00.000Z";

export function memoryRepository() {
  const storage = createMemoryOnboardingStorage();
  const repository = createDemoOnboardingRepository(storage);
  const saves: DemoOnboardingStateV1[] = [];
  const spied: DemoOnboardingRepository = {
    load: () => repository.load(),
    save: (state) => {
      const result = repository.save(state);
      if (result.ok) saves.push(result.state);
      return result;
    },
    clear: () => repository.clear(),
  };
  return { repository: spied, storage, saves };
}

function Harness({
  repository,
  initial = null,
  onExit,
}: {
  repository: DemoOnboardingRepository;
  initial?: DemoOnboardingStateV1 | null;
  onExit: (exit: OnboardingExit) => void;
}) {
  const [locale, setLocale] = useState<SupportedLocale>(initial?.locale ?? "en-SG");
  return (
    <OnboardingFlow
      messages={getMessages(locale)}
      locale={locale}
      onLocaleChange={setLocale}
      repository={repository}
      initialState={initial}
      onExit={onExit}
      now={() => NOW}
    />
  );
}

function setup(initial: DemoOnboardingStateV1 | null = null) {
  const store = memoryRepository();
  const onExit = vi.fn();
  render(<Harness repository={store.repository} initial={initial} onExit={onExit} />);
  return { ...store, onExit };
}

function fact(label: string) {
  return { name: `${label} (${en.shared.optional})` };
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function progress() {
  return screen.getByRole("progressbar", { name: en.onboarding.progressLabel });
}

describe("onboarding welcome", () => {
  it("shows one heading, the compact bilingual boundary, language and both entry actions", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    // Owner decision 2026-10-12: the demo boundary is hidden (DEMO_BOUNDARY_PLACEMENT), Welcome included.
    expect(screen.queryByText(en.onboarding.compactBoundary)).not.toBeInTheDocument();
    expect(screen.queryByText(getMessages("zh-SG").onboarding.compactBoundary)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.settings.english })).toBeChecked();
    expect(screen.getByRole("button", { name: en.onboarding.startSetup })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.onboarding.usePrepared })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("shows no demo boundary on Welcome or the setup steps (owner decision 2026-10-12: DEMO_BOUNDARY_PLACEMENT hidden)", () => {
    setup();
    expect(screen.queryByRole("complementary", { name: en.onboarding.compactBoundary })).not.toBeInTheDocument();
    click(en.onboarding.startSetup);
    expect(progress()).toHaveAttribute("aria-valuenow", "1");
    expect(screen.queryByRole("complementary", { name: en.onboarding.compactBoundary })).not.toBeInTheDocument();
    expect(screen.queryByText(en.onboarding.compactBoundary)).not.toBeInTheDocument();
  });

  it("persists a complete in-progress state when language changes on Welcome", () => {
    const { saves } = setup();
    fireEvent.click(screen.getByRole("radio", { name: en.settings.chinese }));
    expect(
      screen.getByRole("heading", { level: 1, name: getMessages("zh-SG").onboarding.welcomeTitle }),
    ).toBeInTheDocument();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      status: "IN_PROGRESS",
      lastCompletedStep: null,
      locale: "zh-SG",
      preferredName: null,
      medicines: [],
    });
  });

  it("persists the current preferred name when setup is skipped from Profile", () => {
    const { saves } = setup();
    click(en.onboarding.startSetup);
    fireEvent.change(screen.getByLabelText(/Preferred name/), { target: { value: "Mdm Tan" } });
    click(en.onboarding.skipForNow);
    expect(saves.at(-1)).toMatchObject({ status: "SKIPPED", preferredName: "Mdm Tan" });
  });

  it("writes the complete prepared profile and opens Today", () => {
    const { saves, onExit, storage } = setup();
    click(en.onboarding.usePrepared);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ status: "COMPLETED", locale: "en-SG" });
    expect(saves[0]!.medicines.map((m) => m.displayName)).toEqual(["Nocturin pen (demo)", "Veltora pen (demo)"]);
    expect(onExit).toHaveBeenCalledWith({ state: saves[0], destination: "TODAY" });
    expect(storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).not.toBeNull();
  });
});

describe("onboarding primary flow", () => {
  it("runs Welcome → Profile → Medicines → Add → Directions → Review → Complete → Today", () => {
    const { saves, onExit } = setup();
    click(en.onboarding.startSetup);

    // Step 1 — profile.
    expect(progress()).toHaveAttribute("aria-valuenow", "1");
    expect(progress()).toHaveAttribute("aria-valuetext", en.onboarding.stepOf(1, 5));
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.profileTitle })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Preferred name/), { target: { value: "Mdm Tan (demo)" } });
    click(en.shared.continue);
    expect(saves.at(-1)).toMatchObject({
      status: "IN_PROGRESS",
      lastCompletedStep: "PROFILE",
      preferredName: "Mdm Tan (demo)",
      medicines: [],
    });

    // Step 2 — empty list (frame 21).
    expect(progress()).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText(en.onboarding.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shared.continue })).not.toBeInTheDocument();
    click(en.onboarding.addMedicine);

    // Step 3 — fictional selection.
    expect(progress()).toHaveAttribute("aria-valuenow", "3");
    fireEvent.click(screen.getByRole("radio", { name: /Nocturin pen \(demo\)/ }));
    click(en.shared.continue);
    expect(saves.at(-1)).toMatchObject({ lastCompletedStep: "ADD_MEDICINE" });
    expect(saves.at(-1)!.medicines[0]).toMatchObject({
      catalogueKey: "nocturin-pen-demo",
      displayName: "Nocturin pen (demo)",
      genericName: "insulin glargine",
      reviewedContentKey: "insulin-glargine",
      form: null,
      amountAndUnit: null,
      verbatimDirections: null,
      source: "UNKNOWN",
    });

    // Step 4 — recorded directions, separate from reviewed information.
    expect(progress()).toHaveAttribute("aria-valuenow", "4");
    const recorded = screen.getByRole("region", { name: en.onboarding.recordedPrescriptionTitle });
    const about = screen.getByRole("region", { name: en.medication.aboutThisMedicine });
    const medicineValue = within(recorded).getByRole("textbox", { name: en.insulin.medicineLabel });
    // Read-only values wrap under enlarged text, so they are not single-line inputs.
    expect(medicineValue.tagName).not.toBe("INPUT");
    expect(medicineValue).toHaveAttribute("aria-readonly", "true");
    expect(medicineValue).toHaveTextContent("Nocturin pen (demo)");
    expect(within(about).getByText(en.medication.glarginePurpose)).toBeInTheDocument();
    expect(within(about).getByText("insulin glargine")).toBeInTheDocument();
    expect(within(about).getByRole("link", { name: /HealthHub/ })).toBeInTheDocument();
    fireEvent.change(within(recorded).getByRole("textbox", fact(en.onboarding.fieldAmount)), { target: { value: "12 units" } });
    fireEvent.change(within(recorded).getByRole("textbox", fact(en.onboarding.fieldSchedule)), { target: { value: "Daily · 9:00 pm" } });
    fireEvent.change(within(recorded).getByRole("textbox", fact(en.onboarding.fieldDirections)), {
      target: { value: "“Inject 12 units every night at 9 pm” (demo label)" },
    });
    fireEvent.click(within(recorded).getByRole("radio", { name: en.onboarding.sourcePrescriptionLabel }));
    click(en.onboarding.saveRecorded);
    expect(saves.at(-1)).toMatchObject({ lastCompletedStep: "DIRECTIONS" });
    expect(saves.at(-1)!.medicines[0]).toMatchObject({
      amountAndUnit: "12 units",
      scheduleOrTiming: "Daily · 9:00 pm",
      verbatimDirections: "“Inject 12 units every night at 9 pm” (demo label)",
      source: "PRESCRIPTION_LABEL",
      form: null,
      strength: null,
      effectiveDate: null,
    });

    // Step 5 — review.
    expect(progress()).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByText("Mdm Tan (demo)")).toBeInTheDocument();
    expect(screen.getByText("“Inject 12 units every night at 9 pm” (demo label)")).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.notMissed)).toBeInTheDocument();
    click(en.onboarding.finishSetup);
    expect(saves.at(-1)).toMatchObject({ status: "COMPLETED", lastCompletedStep: "REVIEW" });

    // Completion — no step indicator.
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.completeTitle })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    click(en.onboarding.openToday);
    expect(onExit).toHaveBeenCalledWith({ state: saves.at(-1), destination: "TODAY" });
  });

  it("offers the medicine review destination from completion", () => {
    const { onExit, saves } = setup();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    fireEvent.click(screen.getByRole("radio", { name: /Veltora pen \(demo\)/ }));
    click(en.shared.continue);
    click(en.onboarding.saveRecorded);
    click(en.onboarding.finishSetup);
    click(en.onboarding.reviewMedicines);
    expect(onExit).toHaveBeenCalledWith({ state: saves.at(-1), destination: "MY_MEDICINES" });
  });

  it("returns from Review to the medicine list and continues from a non-empty list", () => {
    const { saves } = setup();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    fireEvent.click(screen.getByRole("radio", { name: /Glucotab \(demo\)/ }));
    click(en.shared.continue);
    click(en.onboarding.saveRecorded);
    fireEvent.click(screen.getAllByRole("button", { name: en.shared.back }).at(-1)!);
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.medicinesTitle })).toBeInTheDocument();
    expect(screen.getByText("Glucotab (demo)")).toBeInTheDocument();
    click(en.shared.continue);
    expect(saves.at(-1)).toMatchObject({ lastCompletedStep: "DIRECTIONS" });
    expect(screen.getByRole("heading", { level: 1, name: en.onboarding.reviewTitle })).toBeInTheDocument();
  });
});

describe("reviewed-information evidence", () => {
  function toDirections(choice: RegExp | null, typed = "") {
    const store = setup();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    if (typed) fireEvent.change(screen.getByLabelText(en.onboarding.medicineNameLabel), { target: { value: typed } });
    if (choice) fireEvent.click(screen.getByRole("radio", { name: choice }));
    return store;
  }

  it("shows reviewed aspart content only for Veltora pen (demo) with its visible generic", () => {
    toDirections(/Veltora pen \(demo\)/);
    expect(screen.getByRole("radio", { name: /Veltora pen \(demo\)/ })).toHaveAccessibleName(/insulin aspart/);
    click(en.shared.continue);
    const about = screen.getByRole("region", { name: en.medication.aboutThisMedicine });
    expect(within(about).getByText(en.medication.aspartPurpose)).toBeInTheDocument();
    expect(within(about).getByText("insulin aspart")).toBeInTheDocument();
  });

  it("keeps Glucotab (demo) without reviewed information", () => {
    toDirections(/Glucotab \(demo\)/);
    expect(screen.getByRole("radio", { name: /Glucotab \(demo\)/ })).toHaveAccessibleName(
      new RegExp(en.onboarding.reviewedUnavailableTag),
    );
    click(en.shared.continue);
    const about = screen.getByRole("region", { name: en.medication.aboutThisMedicine });
    expect(about).toHaveTextContent(en.onboarding.reviewedUnavailableBody);
    expect(about).not.toHaveTextContent(en.medication.glarginePurpose);
    expect(within(about).queryByRole("link")).not.toBeInTheDocument();
  });

  it("records a not-listed medicine exactly as typed with no reviewed information", () => {
    const { saves } = toDirections(/Medicine not listed/, "Oxatril (demo)");
    expect(screen.getByText(en.onboarding.recordedExactly)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.noReviewedForEntered)).toBeInTheDocument();
    click(en.shared.continue);
    expect(saves.at(-1)!.medicines[0]).toMatchObject({
      catalogueKey: null,
      enteredName: "Oxatril (demo)",
      displayName: "Oxatril (demo)",
      genericName: null,
      reviewedContentKey: null,
    });
    const about = screen.getByRole("region", { name: en.medication.aboutThisMedicine });
    expect(about).toHaveTextContent(en.onboarding.reviewedUnavailableBody);
  });

  it("does not retain a hidden catalogue choice after the search text changes", () => {
    const { saves } = toDirections(/Nocturin pen \(demo\)/);
    fireEvent.change(screen.getByLabelText(en.onboarding.medicineNameLabel), {
      target: { value: "Oxatril (demo)" },
    });
    click(en.shared.continue);
    expect(saves.at(-1)!.medicines[0]).toMatchObject({
      catalogueKey: null,
      enteredName: "Oxatril (demo)",
      displayName: "Oxatril (demo)",
      genericName: null,
      reviewedContentKey: null,
    });
  });

  it("never renders a placeholder token anywhere in the flow", () => {
    toDirections(/Nocturin pen \(demo\)/);
    click(en.shared.continue);
    expect(document.body.textContent).not.toMatch(/\{[a-zA-Z]+\}|demo-glargine|demo-aspart/);
  });
});

describe("unknown optional fields", () => {
  it("keeps “I don’t know” fields unknown and shows them as unknown on review", () => {
    const { saves } = setup();
    click(en.onboarding.startSetup);
    click(en.shared.continue);
    click(en.onboarding.addMedicine);
    fireEvent.change(screen.getByLabelText(en.onboarding.medicineNameLabel), { target: { value: "Oxatril (demo)" } });
    click(en.shared.continue);
    const recorded = screen.getByRole("region", { name: en.onboarding.recordedPrescriptionTitle });
    fireEvent.change(within(recorded).getByRole("textbox", fact(en.onboarding.fieldStrength)), { target: { value: "100 units/mL" } });
    const strengthUnknown = within(recorded).getByRole("button", { name: en.onboarding.iDontKnowNamed(en.onboarding.fieldStrength) });
    fireEvent.click(strengthUnknown);
    expect(strengthUnknown).toHaveAttribute("aria-pressed", "true");
    const strengthValue = within(recorded).getByRole("textbox", fact(en.onboarding.fieldStrength));
    expect(strengthValue.tagName).not.toBe("INPUT");
    expect(strengthValue).toHaveAttribute("aria-readonly", "true");
    expect(strengthValue).toHaveTextContent(en.onboarding.iDontKnow);
    expect(screen.getByText(en.onboarding.unknownLegend)).toBeInTheDocument();
    fireEvent.click(within(recorded).getByRole("radio", { name: en.onboarding.sourcePatient }));
    click(en.onboarding.saveRecorded);
    expect(saves.at(-1)!.medicines[0]).toMatchObject({
      strength: null,
      form: null,
      amountAndUnit: null,
      scheduleOrTiming: null,
      effectiveDate: null,
      verbatimDirections: null,
      source: "PATIENT_ENTERED",
    });
    expect(screen.getAllByText(en.onboarding.unknownValue).length).toBeGreaterThan(0);
    expect(screen.getByText(en.onboarding.unknownLater)).toBeInTheDocument();
  });
});

describe("locale punctuation", () => {
  const zh = getMessages("zh-SG");
  const labels = () => [...document.querySelectorAll(".review-fact-label, .medicine-card-label")].map((el) => el.textContent);

  it("uses the full-width colon after zh-SG review and list labels", () => {
    const state = { ...persistedWithMedicine, locale: "zh-SG" as const };
    const noop = () => {};
    const { unmount } = render(
      <ReviewStep messages={zh} locale="zh-SG" state={state} onEditProfile={noop} onEditMedicine={noop} onFinish={noop} onBack={noop} />,
    );
    expect(labels()).toContain(`${zh.onboarding.preferredNameLabel}：`);
    expect(labels()).toContain(`${zh.settings.language}：`);
    expect(labels().every((label) => !label?.includes(": "))).toBe(true);
    unmount();
    render(
      <MedicineListStep messages={zh} medicines={state.medicines} mode="MANAGE" title="" onAdd={noop} onEdit={noop} onRemove={noop} />,
    );
    expect(labels()).toContain(`${zh.onboarding.recordedDirectionsLabel}：`);
  });

  it("keeps the English colon and space", () => {
    const noop = () => {};
    render(
      <ReviewStep messages={en} locale="en-SG" state={persistedWithMedicine} onEditProfile={noop} onEditMedicine={noop} onFinish={noop} onBack={noop} />,
    );
    expect(labels()).toContain(`${en.onboarding.preferredNameLabel}: `);
  });
});
