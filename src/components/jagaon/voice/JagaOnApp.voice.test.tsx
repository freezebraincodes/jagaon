// @vitest-environment jsdom
// jsdom is deliberate: the real app shell over the real runtime (fake IndexedDB), like the existing app tests. Synthetic data only; the
// transcriber is the scripted fake injected through the app's test seam (never a production default).
import Dexie from "dexie";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserJournalRuntime, type BrowserJournalRuntimeOptions } from "@/application/journal/browser-journal-runtime";
import { createDemoOnboardingRepository, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import { getMessages } from "@/i18n/get-messages";
import { JagaOnApp } from "../JagaOnApp";
import { createVoiceJournalSave } from "./voice-journal-save";
import { VOICE_SCREEN_PENDING_COPY, voiceScreenCopy } from "./voice-screen-copy";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const en = getMessages("en-SG");
const copy = VOICE_SCREEN_PENDING_COPY["en-SG"].card;
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

type Row = { recordType: string; revisionId: string; revision: { payload: Record<string, unknown> } };

/**
 * The app wiring with production saving connected (the owner's integration gate is lifted): each fact confirmed on its own card is
 * saved through the existing journal commands, exactly once, and the screen shows "Saved." from the save result. Remembering a term is a
 * separate decision that creates no journal event and is reused after a remount. Test 2 exercises the save function the app builds
 * directly against the real runtime (CR-11: the save path's own format check; no 50 mmol/L limit; values stored with one decimal).
 */
describe("Tell JagaOn wired in the app (production saving connected)", () => {
  it(
    "Today → Tell JagaOn → speak → confirm each card: glucose, meal and a taken dose with its amount are saved; remembering adds no event and is reused after a remount",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const rowsAfter = async (seen: ReadonlySet<string>) => {
        const database = await openRaw(name);
        const rows = ((await database.table("recordRevisions").toArray()) as Row[]).filter((row) => !seen.has(row.revisionId));
        database.close();
        return rows;
      };
      const before = new Set((await rowsAfter(new Set())).map((row) => row.revisionId));
      const prepared = createPreparedOnboardingState("en-SG", PACKET10_NOW);
      const mount = (text: string) => {
        const fake = createFakeVoiceTranscriber({ segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text }] });
        render(
          <JagaOnApp
            runtimeFactory={(_name?: string, options?: BrowserJournalRuntimeOptions) => createBrowserJournalRuntime(name, { ...options, now: () => PACKET10_NOW })}
            onboardingRepositoryFactory={() => createDemoOnboardingRepository(createMemoryOnboardingStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }))}
            appointmentNoteStorageFactory={() => createMemoryOnboardingStorage({})}
            voiceTranscriberLoader={async () => fake}
            voiceAvailabilityProbe={async () => true}
          />,
        );
      };
      const speak = async () => {
        const entry = await screen.findByRole("button", { name: en.voice.entry }, { timeout: 30_000 });
        await waitFor(() => expect(entry).not.toBeDisabled(), { timeout: 30_000 });
        fireEvent.click(entry);
        fireEvent.change(await screen.findByLabelText(en.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
        fireEvent.click(screen.getByRole("button", { name: en.voice.disclosure.accept }));
        await waitFor(() => expect(screen.getByRole("button", { name: en.voice.state.stop })).not.toBeDisabled());
        await act(async () => Promise.resolve());
        fireEvent.click(screen.getByRole("button", { name: en.voice.state.stop }));
        return (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
      };
      const saveCard = async (card: HTMLElement) => {
        fireEvent.click(within(card).getByRole("button", { name: copy.save }));
        await waitFor(() => expect(within(card).getByText(copy.saved)).toBeInTheDocument(), { timeout: 30_000 });
        expect(within(card).getByRole("button", { name: copy.save })).toBeDisabled();
      };

      mount("My sugar was 6.8 mmol, I had chicken rice for lunch and I injected 10 units of my dark pen");
      const [glucose, meal, medicine] = await speak();
      await saveCard(glucose!);
      await saveCard(meal!);
      fireEvent.click(within(medicine!).getByRole("button", { name: copy.chooseMedicine }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getAllByRole("radio")[0]!);
      fireEvent.click(within(dialog).getByRole("checkbox"));
      fireEvent.click(within(dialog).getByRole("button", { name: copy.chooseMedicine }));
      await waitFor(() => expect(within(medicine!).getByText(copy.remembered)).toBeInTheDocument());
      // Remembering is its own decision: a terminology record and no medicine event.
      expect((await rowsAfter(before)).map((row) => row.recordType).sort()).toEqual(["GLUCOSE_READING", "INTAKE_EVENT", "PATIENT_TERMINOLOGY"]);
      await saveCard(medicine!);

      const added = await rowsAfter(before);
      expect(added.map((row) => row.recordType).sort()).toEqual(["GLUCOSE_READING", "INTAKE_EVENT", "MEDICATION_EVENT", "PATIENT_TERMINOLOGY"]);
      const payload = (type: string) => added.find((row) => row.recordType === type)!.revision.payload;
      expect(payload("GLUCOSE_READING")).toMatchObject({ measurement: { enteredValue: "6.8", enteredUnit: "MMOL_L" }, measurementMethod: "UNKNOWN", context: { kind: "UNSPECIFIED" } });
      expect(payload("INTAKE_EVENT")).toMatchObject({ intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "LUNCH" }, items: [{ kind: "UNKNOWN", label: "chicken rice" }] });
      const term = payload("PATIENT_TERMINOLOGY") as { phrase: string; meaning: { medication: { recordId: string } } };
      expect(term.phrase).toBe("dark pen");
      expect(payload("MEDICATION_EVENT")).toMatchObject({ state: "TAKEN", medication: { recordType: "MEDICATION", recordId: term.meaning.medication.recordId }, amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } } });

      // Remount (reload): the remembered term is reused without a question; reuse alone writes nothing.
      cleanup();
      const savedSoFar = new Set([...before, ...added.map((row) => row.revisionId)]);
      mount("I injected my dark pen");
      const [again] = await speak();
      expect(within(again!).queryByRole("button", { name: copy.chooseMedicine })).toBeNull();
      expect(within(again!).getByRole("button", { name: copy.save })).toBeEnabled();
      expect(await rowsAfter(savedSoFar)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "the save function the app wires writes each confirmed fact through the runtime's existing commands",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const wired = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW });
      const voice = wired.voice!;
      const [medicine] = await voice.terminology.activeMedicines();
      const database = await openRaw(name);
      const before = new Set(((await database.table("recordRevisions").toArray()) as Row[]).map((row) => row.revisionId));
      const save = createVoiceJournalSave({ commands: wired.commands, recordMedicationEvent: voice.recordMedicationEvent, now: () => PACKET10_NOW });
      expect(await save({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" })).toEqual({ kind: "SAVED" });
      expect(await save({ kind: "MEAL", slot: "LUNCH", itemText: "chicken rice" })).toEqual({ kind: "SAVED" });
      expect(await save({ kind: "MEDICATION_EVENT", medication: medicine!.medication, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "units" } } as never)).toEqual({ kind: "SAVED" });
      // CR-11: no hidden ceiling (the review contract has already required "Save as shown"); malformed values are still refused here.
      expect(await save({ kind: "GLUCOSE", valueText: "99.0", unit: "MMOL_PER_L", unitSource: "PERSON" })).toEqual({ kind: "SAVED" });
      expect(await save({ kind: "GLUCOSE", valueText: "0.0", unit: "MMOL_PER_L", unitSource: "SPOKEN" })).toEqual({ kind: "SAVED" });
      for (const valueText of ["9.25", "60.00", "-5", "1e3", "060", "12345"]) expect(await save({ kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" }), valueText).toEqual({ kind: "NOT_SAVED" });
      const added = ((await database.table("recordRevisions").toArray()) as Row[]).filter((row) => !before.has(row.revisionId));
      expect(added.map((row) => row.recordType).sort()).toEqual(["GLUCOSE_READING", "GLUCOSE_READING", "GLUCOSE_READING", "INTAKE_EVENT", "MEDICATION_EVENT"]);
      expect(added.filter((row) => row.recordType === "GLUCOSE_READING").map((row) => (row.revision.payload.measurement as { enteredValue: string }).enteredValue).sort()).toEqual(["0.0", "6.8", "99.0"]);
      expect(added.find((row) => row.recordType === "MEDICATION_EVENT")!.revision.payload.amountTaken).toEqual({ kind: "KNOWN", amount: { value: "10", unit: "UNIT" } });
      database.close();
      wired.close();
    },
    TIMEOUT,
  );
});

/**
 * Finding N-1 (owner-approved 2026-10-10): a card opens its own existing entry screen; every screen-level fallback offers a chooser
 * (Record a reading / Record a meal / Medication schedule) that opens that existing flow directly and BLANK; Back to Today is a
 * separate exit. Checked through the real app and runtime, in EN and ZH, for every affected state: no record is written by navigation,
 * the transcriber is not loaded again, and nothing is fetched. Case 11 (CR-11): the blank reading form asks for confirmation of 60.
 */
describe.each(["en-SG", "zh-SG"] as const)("Tell JagaOn manual-entry chooser (N-1) %s", (locale) => {
  const m = getMessages(locale);
  const copy = voiceScreenCopy(m, locale);
  const say =
    locale === "en-SG"
      ? { case11: "My sugar was 60 mmol", dose: "How many tablets should I take?", reading: "My sugar was 6.8 mmol" }
      : { case11: "血糖60毫摩尔", dose: "我应该吃几片药？", reading: "血糖六点八毫摩尔" };

  async function mountApp() {
    const { name, runtime } = await createPopulatedDataset();
    names.push(name);
    runtime.close();
    const database = await openRaw(name);
    const revisions = async () => ((await database.table("recordRevisions").toArray()) as Row[]).map((row) => row.revisionId).sort();
    const control = { script: { segmentsOnStart: [] } as FakeVoiceTranscriberScript, available: true, loads: 0 };
    render(
      <JagaOnApp
        runtimeFactory={(_name?: string, options?: BrowserJournalRuntimeOptions) => createBrowserJournalRuntime(name, { ...options, now: () => PACKET10_NOW })}
        onboardingRepositoryFactory={() =>
          createDemoOnboardingRepository(createMemoryOnboardingStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(createPreparedOnboardingState(locale, PACKET10_NOW)) }))
        }
        appointmentNoteStorageFactory={() => createMemoryOnboardingStorage({})}
        voiceTranscriberLoader={async () => {
          control.loads += 1;
          return createFakeVoiceTranscriber(control.script);
        }}
        voiceAvailabilityProbe={async () => control.available}
      />,
    );
    return { database, revisions, control };
  }
  type App = Awaited<ReturnType<typeof mountApp>>;

  const onToday = async () => {
    const entry = await screen.findByRole("button", { name: m.voice.entry }, { timeout: 30_000 });
    expect(screen.getByRole("button", { name: m.today.recordReading })).toBeInTheDocument();
    return entry;
  };
  // Test navigation only (not under test): Back until the bottom navigation shows, then the Today tab.
  const homeViaTabs = async () => {
    for (let step = 0; step < 4 && screen.queryByRole("navigation") === null; step += 1) {
      fireEvent.click(document.querySelector(".screen-back-button") as HTMLButtonElement);
      await act(async () => Promise.resolve());
    }
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: m.shared.navToday }));
    await onToday();
  };
  const openVoice = async (app: App, script: FakeVoiceTranscriberScript, available = true) => {
    app.control.script = script;
    app.control.available = available;
    const entry = await onToday();
    await waitFor(() => expect(entry).not.toBeDisabled(), { timeout: 30_000 });
    fireEvent.click(entry);
    if (!available) return;
    fireEvent.change(await screen.findByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
  };
  const accept = () => fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
  const stopWhenListening = async () => {
    await waitFor(() => expect(screen.getByRole("button", { name: m.voice.state.stop })).not.toBeDisabled(), { timeout: 30_000 });
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: m.voice.state.stop }));
  };
  const speak = async (app: App, text: string) => {
    await openVoice(app, { segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text }] });
    accept();
    await stopWhenListening();
  };

  /** Each affected state: how to reach it, and the status or text that proves it was reached. */
  const STATES: ReadonlyArray<readonly [string, (app: App) => Promise<void>, string]> = [
    ["review (case 11)", async (app) => speak(app, say.case11), copy.card.confirmBody],
    ["redirect-only", async (app) => speak(app, say.dose), m.voice.redirect.transcribedNote],
    ["voice unavailable", async (app) => openVoice(app, { segmentsOnStart: [] }, false), copy.state.unavailable],
    ["provider failure", async (app) => { await openVoice(app, { start: { kind: "FAILED", reason: "PROVIDER_FAILURE" } }); accept(); }, copy.state.unavailable],
    ["permission denied", async (app) => { await openVoice(app, { start: { kind: "FAILED", reason: "PERMISSION_DENIED" } }); accept(); }, copy.state.permissionDenied],
    ["unsupported browser", async (app) => { await openVoice(app, { start: { kind: "FAILED", reason: "UNSUPPORTED_BROWSER" } }); accept(); }, copy.state.unsupported],
    ["passcode refused", async (app) => { await openVoice(app, { start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" } }); accept(); }, copy.state.accessDenied],
    ["declined", async (app) => { await openVoice(app, { segmentsOnStart: [] }); fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.decline })); }, copy.state.declined],
    [
      "cancelled",
      async (app) => {
        await openVoice(app, { segmentsOnStart: [] });
        accept();
        await waitFor(() => expect(screen.getByRole("button", { name: m.voice.state.stop })).not.toBeDisabled(), { timeout: 30_000 });
        fireEvent.click(screen.getByRole("button", { name: m.voice.state.cancel }));
      },
      copy.state.cancelled,
    ],
    // W-6a (deliberate change): the listening limit stops like Stop. Round 4: a 1 s server limit is not the 60 s limit, so the plain stop
    // path applies (no "60-second" notice); nothing was captured, so the nothing-understood state.
    ["listening limit below 60 s, nothing captured", async (app) => { await openVoice(app, { start: { kind: "STARTED", maxSessionSeconds: 1 } }); accept(); }, copy.review.nothingFound],
    ["nothing understood", async (app) => { await openVoice(app, { segmentsOnStart: [] }); accept(); await stopWhenListening(); }, copy.review.nothingFound],
  ];
  const DESTINATIONS: ReadonlyArray<readonly [string, string]> = [
    [copy.review.manualReading, m.today.recordReading],
    [copy.review.manualMeal, m.meal.screenTitle],
    [copy.review.manualMedicine, m.schedule.title],
  ];

  it(
    "every affected state offers the chooser; each choice opens its existing flow blank and Back to Today exits; nothing is saved, reloaded or fetched",
    async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const app = await mountApp();
      const before = await app.revisions();
      for (const [state, reach, proof] of STATES) {
        for (const [label, heading] of [...DESTINATIONS, [copy.review.backToToday, null] as const]) {
          await reach(app);
          expect(await screen.findByText(proof, {}, { timeout: 30_000 }), state).toBeInTheDocument();
          const chooser = screen.getByRole("region", { name: copy.review.manualHeading });
          expect(within(chooser).getByRole("heading", { level: 2 }), state).toHaveTextContent(locale === "en-SG" ? "Add another entry" : "添加其他记录");
          const loads = app.control.loads;
          if (heading === null) {
            // Back to Today is a separate exit, outside the chooser.
            expect(within(chooser).queryByRole("button", { name: copy.review.backToToday })).toBeNull();
            fireEvent.click(screen.getByRole("button", { name: copy.review.backToToday }));
            await onToday();
          } else {
            fireEvent.click(within(chooser).getByRole("button", { name: label }));
            expect(await screen.findByRole("heading", { level: 1, name: heading }), `${state} → ${label}`).toBeInTheDocument();
            if (heading === m.today.recordReading) {
              expect((screen.getByRole("textbox", { name: new RegExp(`^${m.glucose.valueLabel}`) }) as HTMLInputElement).value).toBe("");
            }
            if (heading === m.schedule.title) {
              // Medication schedule keeps the person's existing medicines (it is not cleared).
              expect(await screen.findAllByText(/Lantus/, {}, { timeout: 30_000 })).not.toHaveLength(0);
            }
            await homeViaTabs();
          }
          expect(app.control.loads, `${state}: no voice restart`).toBe(loads);
        }
      }
      expect(await app.revisions()).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      app.database.close();
    },
    TIMEOUT,
  );

  it(
    "case 11 (CR-11): the card opens a blank reading form; 60 there asks for confirmation and Cancel saves nothing",
    async () => {
      const app = await mountApp();
      const before = await app.revisions();
      await speak(app, say.case11);
      const [card] = (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
      fireEvent.click(within(card!).getByRole("button", { name: copy.card.manualGlucose }));
      expect(await screen.findByRole("heading", { level: 1, name: m.today.recordReading })).toBeInTheDocument();
      const value = screen.getByRole("textbox", { name: new RegExp(`^${m.glucose.valueLabel}`) }) as HTMLInputElement;
      expect(value.value).toBe("");
      fireEvent.change(value, { target: { value: "60" } });
      fireEvent.click(screen.getByRole("radio", { name: m.glucose.contextBedtime }));
      fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
      expect(await screen.findByText(m.glucose.confirmBody)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: `60.0 ${m.glucose.unit}` })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: m.glucose.cancelConfirm }));
      expect(await app.revisions()).toEqual(before);
      // The other cards keep their own destinations.
      await homeViaTabs();
      await speak(app, locale === "en-SG" ? "I had chicken rice for lunch and I injected my dark pen" : "我午饭吃了鸡饭，然后打了黑色的笔");
      let cards = (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
      fireEvent.click(within(cards[0]!).getByRole("button", { name: copy.card.manualMeal }));
      expect(await screen.findByRole("heading", { level: 1, name: m.meal.screenTitle })).toBeInTheDocument();
      await homeViaTabs();
      await speak(app, locale === "en-SG" ? "I had chicken rice for lunch and I injected my dark pen" : "我午饭吃了鸡饭，然后打了黑色的笔");
      cards = (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
      fireEvent.click(within(cards[1]!).getByRole("button", { name: copy.card.manualMedicine }));
      expect(await screen.findByRole("heading", { level: 1, name: m.schedule.title })).toBeInTheDocument();
      expect(await app.revisions()).toEqual(before);
      app.database.close();
    },
    TIMEOUT,
  );

  it(
    "done-saved keeps the saved confirmation and the same chooser heading, and navigating never saves again",
    async () => {
      const app = await mountApp();
      const before = await app.revisions();
      await speak(app, say.reading);
      const [card] = (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
      fireEvent.click(within(card!).getByRole("button", { name: copy.card.save }));
      await waitFor(() => expect(within(card!).getByText(copy.card.saved)).toBeInTheDocument(), { timeout: 30_000 });
      const saved = await app.revisions();
      expect(saved.length).toBe(before.length + 1);
      fireEvent.click(screen.getByRole("button", { name: copy.review.discard }));
      expect(await screen.findByText(copy.state.doneSaved)).toBeInTheDocument();
      // The owner's single chooser heading (2026-10-11), the same on every screen that shows the chooser.
      expect(copy.review.manualHeading).toBe(locale === "en-SG" ? "Add another entry" : "添加其他记录");
      const chooser = screen.getByRole("region", { name: copy.review.manualHeading });
      fireEvent.click(within(chooser).getByRole("button", { name: copy.review.manualReading }));
      expect(await screen.findByRole("heading", { level: 1, name: m.today.recordReading })).toBeInTheDocument();
      expect((screen.getByRole("textbox", { name: new RegExp(`^${m.glucose.valueLabel}`) }) as HTMLInputElement).value).toBe("");
      await homeViaTabs();
      expect(await app.revisions()).toEqual(saved);
      app.database.close();
    },
    TIMEOUT,
  );
});
