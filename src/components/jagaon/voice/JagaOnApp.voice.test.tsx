// @vitest-environment jsdom
// jsdom is deliberate: the real app shell over the real runtime (fake IndexedDB), like the existing app tests. Synthetic data only; the
// transcriber is the scripted fake injected through the app's test seam (never a production default).
import Dexie from "dexie";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserJournalRuntime, type BrowserJournalRuntimeOptions } from "@/application/journal/browser-journal-runtime";
import { createDemoOnboardingRepository, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createFakeVoiceTranscriber } from "@/application/voice/fake-voice-transcriber";
import { getMessages } from "@/i18n/get-messages";
import { JagaOnApp } from "../JagaOnApp";
import { createVoiceJournalSave } from "./voice-journal-save";
import { VOICE_SCREEN_PENDING_COPY } from "./voice-screen-copy";

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
 * directly against the real runtime (including the manual range refusal).
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
      expect(await save({ kind: "GLUCOSE", valueText: "99", unit: "MMOL_PER_L", unitSource: "PERSON" })).toEqual({ kind: "NOT_SAVED" });
      const added = ((await database.table("recordRevisions").toArray()) as Row[]).filter((row) => !before.has(row.revisionId));
      expect(added.map((row) => row.recordType).sort()).toEqual(["GLUCOSE_READING", "INTAKE_EVENT", "MEDICATION_EVENT"]);
      expect(added.find((row) => row.recordType === "MEDICATION_EVENT")!.revision.payload.amountTaken).toEqual({ kind: "KNOWN", amount: { value: "10", unit: "UNIT" } });
      database.close();
      wired.close();
    },
    TIMEOUT,
  );
});
