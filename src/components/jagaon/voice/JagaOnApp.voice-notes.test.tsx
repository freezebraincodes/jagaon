// @vitest-environment jsdom
// jsdom is deliberate: the real app shell over the real runtime (fake IndexedDB), like the existing app voice tests. Synthetic data
// only; the transcriber is the scripted fake injected through the app's test seam (never a production default). No network, no AI.
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

installFakeIndexedDb();
const TIMEOUT = 240_000;
const en = getMessages("en-SG");
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

type Row = { recordType: string; revisionId: string; revision: { payload: Record<string, unknown> } };

/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more): in the real app, "Feeling tired and a bit worried today" shows a Feeling
 * card whose "Save as a note" stores one personal note (her words plus the reviewed kind sentence; no AI), and "Walked 30 minutes
 * after dinner" shows an Activity card whose Save records one activity event through the existing command.
 */
describe("Tell JagaOn: feelings become notes, activities go to the activity log (app wiring)", () => {
  it(
    "Feeling card → Save as a note → the note is stored; Activity card → Save → the activity is recorded",
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

      // A feeling: one card, no "Talk it through" until the feelings chat is wired, saved as a note.
      mount("Feeling tired and a bit worried today.");
      const [feeling] = await speak();
      expect(within(feeling!).getByRole("heading", { name: en.voice.feeling.heading })).toBeInTheDocument();
      expect(within(feeling!).queryByRole("button", { name: en.voice.feeling.talkItThrough })).toBeNull();
      fireEvent.click(within(feeling!).getByRole("button", { name: en.voice.feeling.saveAsNote }));
      await waitFor(() => expect(within(feeling!).getByText(en.voice.feeling.savedToNotes)).toBeInTheDocument(), { timeout: 30_000 });
      expect(within(feeling!).getByText("That sounds like a tiring day. Thank you for telling me.")).toBeInTheDocument();

      const afterNote = await rowsAfter(before);
      expect(afterNote.map((row) => row.recordType)).toEqual(["PERSONAL_NOTE"]);
      expect(afterNote[0]!.revision.payload).toEqual({
        text: "Feeling tired and a bit worried today.",
        language: "en-SG",
        feelingCues: ["tired", "worried"],
        turns: [
          { role: "PATIENT", text: "Feeling tired and a bit worried today.", source: "PATIENT" },
          { role: "JAGAON_KIND_SENTENCE", text: "That sounds like a tiring day. Thank you for telling me.", source: "REVIEWED_BANK" },
        ],
        themes: [],
        aiUsed: false,
        promptVersion: null,
        careQuestionRef: null,
      });
      // The runtime's notes query lists it (My notes reads the same query).
      const reader = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW });
      expect((await reader.notes!.query.listPersonalNotes()).map((note) => note.payload.text)).toContain("Feeling tired and a bit worried today.");
      reader.close();

      // An activity: one card, saved to the activity log through the existing command.
      cleanup();
      const seen = new Set([...before, ...afterNote.map((row) => row.revisionId)]);
      mount("Walked 30 minutes after dinner");
      const [activity] = await speak();
      expect(within(activity!).getByText("Walk · 30 min · after dinner")).toBeInTheDocument();
      fireEvent.click(within(activity!).getByRole("button", { name: en.voice.activity.save }));
      await waitFor(() => expect(within(activity!).getByText(en.voice.activity.saved)).toBeInTheDocument(), { timeout: 30_000 });
      const afterActivity = await rowsAfter(seen);
      expect(afterActivity.map((row) => row.recordType)).toEqual(["ACTIVITY_EVENT"]);
      expect(afterActivity[0]!.revision.payload).toEqual({ activityCategory: "WALKING", patientLabel: "Walked 30 minutes after dinner", reportedDurationMinutes: 30 });
    },
    TIMEOUT,
  );
});
