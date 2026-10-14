import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { computeCareNudges, type ReportedCompletion } from "@/application/preview/care-nudges";
import type { PreventiveCareView } from "@/application/care-organisation/care-organisation-contracts";
import type { TodayJournalViewModel } from "@/application/journal/journal-contracts";
import { AppShell } from "../AppShell";
import { TodayScreen } from "../screens/TodayScreen";
import { HSA_BOUNDED_MODE_STORAGE_KEY, HsaBoundedModeProvider, resetHsaBoundedModeForTests, useHsaBoundedMode } from "./hsa-bounded-mode";
import { useCareNudgeSummary } from "./care-nudges";

const en = getMessages("en-SG");
const copy = en.hsaCareNudges;
// Wednesday 14 Oct 2026, 10:00 in Singapore.
const NOW = new Date("2026-10-14T02:00:00.000Z");
/** The synthetic seed's reported completions. */
const DEMO_COMPLETIONS: ReportedCompletion[] = [
  { catalogueEntryKey: "BLOOD_TEST", localDate: "2026-05-12" },
  { catalogueEntryKey: "EYE_SCREENING", localDate: "2025-09-09" },
  { catalogueEntryKey: "FOOT_CHECK", localDate: "2026-09-14" },
];
const journal: TodayJournalViewModel = { unavailable: false, entries: [] };

function renderToday(navigate = vi.fn()) {
  render(
    <HsaBoundedModeProvider>
      <TodayScreen
        messages={en}
        locale="en-SG"
        fixture={createDemoScenarioFixture()}
        journal={journal}
        navigate={navigate}
        now={NOW}
        careNudges={computeCareNudges(DEMO_COMPLETIONS, NOW)}
      />
    </HsaBoundedModeProvider>,
  );
  return { navigate, card: screen.getByRole("region", { name: /^Care planning/ }) };
}

function Toggle() {
  const { bounded, setBounded } = useHsaBoundedMode();
  return (
    <button type="button" onClick={() => setBounded(!bounded)}>
      toggle
    </button>
  );
}

function BadgeProbe({ query }: { query: { loadPreventiveCare(): Promise<PreventiveCareView> } }) {
  const summary = useCareNudgeSummary(query, undefined, () => NOW);
  return <p data-testid="due">{summary ? String(summary.dueCount) : "none"}</p>;
}

function renderShellWithBadge(view: PreventiveCareView) {
  const query = { loadPreventiveCare: vi.fn(async () => view) };
  render(
    <HsaBoundedModeProvider>
      <AppShell messages={en} currentScreen="TODAY" isTopLevel onBack={vi.fn()} onSwitchTab={vi.fn()}>
        <BadgeProbe query={query} />
        <Toggle />
      </AppShell>
    </HsaBoundedModeProvider>,
  );
  return { query };
}

describe("Care nudges preview (HSA-bounded mode off only, owner decision 2026-10-14)", () => {
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

  it("ON (default): Today's care card keeps the entered dates and existing copy, with no bell, chip or preview tag", () => {
    const { card } = renderToday();
    expect(within(card).getByRole("heading", { name: en.today.careDatesHeading })).toBeTruthy();
    expect(card).toHaveTextContent("Shows only what you entered. The app doesn't decide what is due.");
    expect(within(card).queryByRole("img", { name: copy.bellLabel(1) })).toBeNull();
    expect(within(card).queryByRole("list", { name: copy.listLabel })).toBeNull();
    expect(within(card).queryByText(en.hsa.previewTag)).toBeNull();
    expect(within(card).queryByRole("button", { name: /Set a date/ })).toBeNull();
  });

  it("OFF: bell with the due count, DUE chip as text, last record, source line, and Set a date opens My health checks", () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const { card, navigate } = renderToday();
    expect(within(card).getByRole("heading", { name: "Care planning · 1 due" })).toBeTruthy();
    expect(within(card).getByRole("img", { name: "1 care check due" })).toHaveTextContent("1");
    expect(within(card).getByText(en.hsa.previewTag)).toBeTruthy();
    // The entered dates stay; the bounded "doesn't decide what is due" note is replaced by the preview note.
    for (const date of createDemoScenarioFixture().careDates) expect(card).toHaveTextContent(date.label);
    expect(card).not.toHaveTextContent(en.today.careDatesNote);
    expect(card).toHaveTextContent(copy.note);

    const rows = within(within(card).getByRole("list", { name: copy.listLabel })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".care-nudge-label")?.textContent)).toEqual(["Eye screening", "HbA1c (blood test)", "Foot check"]);
    const [eye, bloodTest, foot] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(eye).getByText("Due")).toBeTruthy();
    expect(eye).toHaveTextContent(/Last recorded Sept? 2025 · 13 months ago/);
    expect(eye).toHaveTextContent("Usually yearly · Singapore guidance (MOH/HPB). Check with your care team.");
    expect(bloodTest).toHaveTextContent("Due soon · in 4 weeks");
    expect(bloodTest).toHaveTextContent("Usually every 3–6 months · Singapore guidance (MOH/HPB). Check with your care team.");
    expect(foot).toHaveTextContent("Due in 11 months");
    expect(foot).toHaveTextContent(/Last recorded Sept? 2026 · 1 month ago/);
    expect(within(foot).queryByRole("button")).toBeNull();
    expect(within(foot).queryByText("Due")).toBeNull();

    fireEvent.click(within(eye).getByRole("button", { name: "Set a date · Eye screening" }));
    expect(navigate).toHaveBeenCalledWith("PREVENTIVE_CARE");
    // Still no clinical or adherence wording.
    expect((card.textContent ?? "").toLowerCase()).not.toMatch(/missed|overdue|urgent|risk|safe|high|low/);
  });

  it("OFF with nothing recorded: every check says No record yet and is due", () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    render(
      <HsaBoundedModeProvider>
        <TodayScreen messages={en} locale="en-SG" fixture={createDemoScenarioFixture()} journal={journal} navigate={vi.fn()} now={NOW} careNudges={computeCareNudges([], NOW)} />
      </HsaBoundedModeProvider>,
    );
    const card = screen.getByRole("region", { name: "Care planning · 3 due" });
    expect(within(card).getAllByText(copy.noRecord)).toHaveLength(3);
    expect(within(card).getAllByText("Due")).toHaveLength(3);
  });

  it("More badge: set to the due count while OFF, hidden while ON, cleared when nothing is due", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const { query } = renderShellWithBadge({ status: "READY", items: [], reportedCompletions: DEMO_COMPLETIONS });
    await waitFor(() => expect(screen.getByLabelText(en.hsa.moreBadgeLabel(1))).toHaveTextContent("1"));
    expect(screen.getByTestId("due")).toHaveTextContent("1");

    act(() => fireEvent.click(screen.getByRole("button", { name: "toggle" })));
    expect(screen.queryByLabelText(en.hsa.moreBadgeLabel(1))).toBeNull();
    expect(screen.getByTestId("due")).toHaveTextContent("none");
    const callsWhileOn = query.loadPreventiveCare.mock.calls.length;
    expect(callsWhileOn).toBe(1);

    cleanup();
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    renderShellWithBadge({ status: "READY", items: [], reportedCompletions: [...DEMO_COMPLETIONS, { catalogueEntryKey: "EYE_SCREENING", localDate: "2026-10-01" }] });
    await waitFor(() => expect(screen.getByTestId("due")).toHaveTextContent("0"));
    expect(document.querySelector(".app-nav-badge")).toBeNull();
  });

  it("does not load anything while ON, and an unreadable store shows no badge", async () => {
    const { query } = renderShellWithBadge({ status: "READY", items: [], reportedCompletions: [] });
    expect(query.loadPreventiveCare).not.toHaveBeenCalled();
    expect(document.querySelector(".app-nav-badge")).toBeNull();
    cleanup();
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const unavailable = renderShellWithBadge({ status: "UNAVAILABLE" });
    await waitFor(() => expect(unavailable.query.loadPreventiveCare).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.getByTestId("due")).toHaveTextContent("none");
    expect(document.querySelector(".app-nav-badge")).toBeNull();
  });
});
