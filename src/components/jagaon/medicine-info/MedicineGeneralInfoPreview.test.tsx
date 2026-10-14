import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { createMedicineInfoClient } from "@/application/medicine-info/medicine-info-client";
import type { DemoOnboardingMedicine, DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import { MEDICINE_INFO_DIRECTIONS_SENTENCE } from "@/domain/medicine-info/medicine-info-validator";
import { getMessages } from "@/i18n/get-messages";
import { HSA_BOUNDED_MODE_STORAGE_KEY, HsaBoundedModeProvider, resetHsaBoundedModeForTests } from "../hsa/hsa-bounded-mode";
import { DirectionsStep } from "../onboarding/DirectionsStep";
import { MedicationInformationScreen } from "../screens/MedicationInformationScreen";
import { HEALTHHUB_MEDICATIONS_URL, MedicineInfoClientProvider } from "./MedicineGeneralInfoPreview";

/**
 * HSA preview (owner decision 2026-10-14): "Get general information with AI" on My medicines ("About these medicines") and the
 * directions step. A fake fetcher stands in for the route (no network, no live call). Synthetic data only.
 */

const en = getMessages("en-SG");
const t = en.hsaMedicineInfo;
const USED_FOR = "Metformin is a medicine used to help control blood sugar in people with type 2 diabetes.";
const HOW_TAKEN = `It is generally taken by mouth with or after meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`;
const INFO = { name: "Metformin", genericName: null, usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const medicine = (overrides: Partial<DemoOnboardingMedicine>): DemoOnboardingMedicine => ({
  id: "44444444-4444-4444-8444-444444444444",
  catalogueKey: null,
  enteredName: "Metformin",
  displayName: "Metformin",
  genericName: null,
  form: null,
  strength: null,
  amountAndUnit: null,
  scheduleOrTiming: null,
  effectiveDate: null,
  verbatimDirections: "1 tablet after breakfast",
  source: "PATIENT_ENTERED",
  reviewedContentKey: null,
  ...overrides,
});
const LANTUS = medicine({ id: "55555555-5555-4555-8555-555555555555", catalogueKey: "lantus-demo", enteredName: "Lantus", displayName: "Lantus", genericName: "insulin glargine", reviewedContentKey: "insulin-glargine", verbatimDirections: "10 units at bedtime" });
const METFORMIN = medicine({});
const STATE: DemoOnboardingStateV1 = { schemaVersion: 1, status: "COMPLETED", lastCompletedStep: "REVIEW", locale: "en-SG", preferredName: "Mdm Tan", medicines: [LANTUS, METFORMIN], updatedAt: "2026-10-14T00:00:00.000Z" };

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  resetHsaBoundedModeForTests();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fakeRoute(replies: Array<() => Response | Promise<Response>>) {
  const bodies: unknown[] = [];
  let index = 0;
  const client = createMedicineInfoClient({
    fetcher: async (_input, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return (replies[Math.min(index++, replies.length - 1)] ?? (() => json({ kind: "NOT_FOUND" })))();
    },
    now: () => new Date("2026-10-14T03:00:00.000Z"),
  });
  return { client, bodies };
}

function renderScreen(options: { bounded: boolean; replies?: Array<() => Response | Promise<Response>> }) {
  if (!options.bounded) store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
  const route = fakeRoute(options.replies ?? [() => json({ kind: "OK", info: INFO })]);
  render(
    <HsaBoundedModeProvider>
      <MedicineInfoClientProvider client={route.client}>
        <MedicationInformationScreen messages={en} locale="en-SG" fixture={createDemoScenarioFixture(STATE)} goBack={vi.fn()} />
      </MedicineInfoClientProvider>
    </HsaBoundedModeProvider>,
  );
  return route;
}

const metforminCard = () => screen.getByRole("article", { name: "Metformin" });

describe("Get general information with AI (HSA preview)", () => {
  it("bounded mode ON (the default): no button on My medicines, nothing sent; the unreviewed copy is unchanged", () => {
    const { bodies } = renderScreen({ bounded: true });
    expect(screen.queryByRole("button", { name: t.getButton })).toBeNull();
    expect(within(metforminCard()).getByText(en.medication.infoUnavailable)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it("bounded mode OFF: notice → card → refresh, sending only the medicine name", async () => {
    const fresher = { ...INFO, usedFor: "Metformin is a medicine used to help control blood sugar in adults with type 2 diabetes." };
    const { bodies } = renderScreen({ bounded: false, replies: [() => json({ kind: "OK", info: INFO }), () => json({ kind: "OK", info: fresher })] });
    const card = metforminCard();
    fireEvent.click(within(card).getByRole("button", { name: t.getButton }));
    const dialog = screen.getByRole("dialog", { name: t.noticeTitle });
    expect(dialog).toHaveTextContent(t.noticeBody("Metformin"));
    expect(bodies).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: t.noticeContinue }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(card).getByRole("status")).toHaveTextContent(t.loading);

    const info = await within(card).findByRole("article", { name: t.cardTitle("Metformin") });
    expect(info).toHaveTextContent(en.hsa.previewTag);
    expect(info).toHaveTextContent(t.cardTag);
    expect(info).toHaveTextContent(t.usedForLabel);
    expect(info).toHaveTextContent(USED_FOR);
    expect(info).toHaveTextContent(t.howTakenLabel);
    expect(info).toHaveTextContent(HOW_TAKEN);
    expect(info).toHaveTextContent(t.generatedOn("14 Oct 2026"));
    expect(info).toHaveTextContent(t.caution);
    const link = within(info).getByRole("link", { name: new RegExp(t.searchHealthHub) });
    expect(link).toHaveAttribute("href", HEALTHHUB_MEDICATIONS_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    // Only the name was sent: never the recorded directions, readings or her name.
    expect(bodies).toEqual([{ task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin" }]);
    expect(JSON.stringify(bodies)).not.toMatch(/tablet after breakfast|Mdm Tan/);
    // Her recorded directions are unchanged.
    expect(card).toHaveTextContent("1 tablet after breakfast");

    fireEvent.click(within(info).getByRole("button", { name: t.refresh }));
    expect(await within(card).findByText(fresher.usedFor)).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
  });

  it("the notice is shown once per medicine; a cached answer is shown at once on the next visit", async () => {
    const { bodies } = renderScreen({ bounded: false });
    fireEvent.click(within(metforminCard()).getByRole("button", { name: t.getButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.noticeContinue }));
    await within(metforminCard()).findByRole("article", { name: t.cardTitle("Metformin") });
    cleanup();
    renderScreen({ bounded: false });
    expect(within(metforminCard()).getByRole("article", { name: t.cardTitle("Metformin") })).toHaveTextContent(USED_FOR);
    expect(bodies).toHaveLength(1);
  });

  it("Cancel on the notice sends nothing and keeps the button", () => {
    const { bodies } = renderScreen({ bounded: false });
    fireEvent.click(within(metforminCard()).getByRole("button", { name: t.getButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.noticeCancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(metforminCard()).getByRole("button", { name: t.getButton })).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it.each<[string, () => Response]>([
    ["NOT_FOUND", () => json({ kind: "NOT_FOUND" })],
    ["REJECTED", () => json({ kind: "REJECTED", reasons: ["DOSE_AMOUNT"] })],
    ["an answer the device rejects", () => json({ kind: "OK", info: { ...INFO, usedFor: "Metformin cures diabetes in most adults who take it." } })],
  ])("%s → the 'no reliable information' message, no card", async (_name, reply) => {
    renderScreen({ bounded: false, replies: [reply] });
    fireEvent.click(within(metforminCard()).getByRole("button", { name: t.getButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.noticeContinue }));
    expect(await within(metforminCard()).findByText(t.noReliableInfo)).toBeInTheDocument();
    expect(within(metforminCard()).queryByRole("article")).toBeNull();
    expect(screen.queryByText(/cures diabetes/)).toBeNull();
  });

  it("unavailable → a short line and the button again; the credit limit → the AI credit-limit dialog", async () => {
    renderScreen({ bounded: false, replies: [() => json({ kind: "UNAVAILABLE", reason: "SPEND_CEILING_REACHED" }), () => json({ kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" })] });
    fireEvent.click(within(metforminCard()).getByRole("button", { name: t.getButton }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.noticeContinue }));
    const credit = await screen.findByRole("dialog", { name: en.aiCreditLimit.title });
    expect(credit).toHaveTextContent(t.creditLimitBody);
    fireEvent.click(within(credit).getByRole("button", { name: en.aiCreditLimit.ok }));
    expect(within(metforminCard()).getByText(t.unavailable)).toBeInTheDocument();
    fireEvent.click(within(metforminCard()).getByRole("button", { name: t.getButton }));
    await waitFor(() => expect(within(metforminCard()).getByText(t.unavailable)).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: en.aiCreditLimit.title })).toBeNull();
  });

  it("a medicine with reviewed HealthHub information keeps its reviewed card unchanged, with no AI button", () => {
    renderScreen({ bounded: false });
    const lantus = screen.getByRole("article", { name: "Lantus" });
    expect(within(lantus).getByRole("link", { name: `${en.shared.source}: HealthHub` })).toBeInTheDocument();
    expect(within(lantus).queryByRole("button", { name: t.getButton })).toBeNull();
    expect(screen.getAllByRole("button", { name: t.getButton })).toHaveLength(1);
  });
});

describe("the directions step (onboarding and My medicines)", () => {
  function renderStep(bounded: boolean, item: DemoOnboardingMedicine) {
    if (!bounded) store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const route = fakeRoute([() => json({ kind: "OK", info: INFO })]);
    const onSave = vi.fn();
    render(
      <HsaBoundedModeProvider>
        <MedicineInfoClientProvider client={route.client}>
          <DirectionsStep messages={en} locale="en-SG" medicine={item} onSave={onSave} />
        </MedicineInfoClientProvider>
      </HsaBoundedModeProvider>,
    );
    return { ...route, onSave };
  }

  it("bounded ON: only the unavailable copy", () => {
    renderStep(true, METFORMIN);
    expect(screen.getByText(en.onboarding.reviewedUnavailableBody)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.getButton })).toBeNull();
  });

  it("bounded OFF: the AI lookup shows its card and never submits the directions form", async () => {
    const { onSave } = renderStep(false, METFORMIN);
    fireEvent.click(screen.getByRole("button", { name: t.getButton }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t.noticeContinue }));
    });
    expect(await screen.findByRole("article", { name: t.cardTitle("Metformin") })).toHaveTextContent(USED_FOR);
    fireEvent.click(screen.getByRole("button", { name: t.refresh }));
    await screen.findByRole("article", { name: t.cardTitle("Metformin") });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a reviewed medicine (Lantus) keeps the reviewed information and no AI button", () => {
    renderStep(false, LANTUS);
    expect(screen.getByText(en.medication.glarginePurpose)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.getButton })).toBeNull();
  });

  it("no button for a name the request could not carry", () => {
    renderStep(false, medicine({ enteredName: "Metformin/Glucophage", displayName: "Metformin/Glucophage" }));
    expect(screen.queryByRole("button", { name: t.getButton })).toBeNull();
  });
});
