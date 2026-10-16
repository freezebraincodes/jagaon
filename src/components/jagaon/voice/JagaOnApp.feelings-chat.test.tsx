// @vitest-environment jsdom
// jsdom is deliberate: the real app shell over the real runtime (fake IndexedDB), like the existing app voice tests. Synthetic data
// only; the transcriber and the feelings-chat port are scripted fakes injected through the app's test seams (never production
// defaults). No network, no AI, no live call.
import Dexie from "dexie";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeFeelingsChatPort, type FakeFeelingsChatStep } from "@/application/feelings-chat/feelings-chat-fake-port";
import { createBrowserJournalRuntime, type BrowserJournalRuntimeOptions } from "@/application/journal/browser-journal-runtime";
import { createDemoOnboardingRepository, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createFakeVoiceTranscriber } from "@/application/voice/fake-voice-transcriber";
import { FALLBACK_QUESTIONS, KIND_SENTENCES } from "@/domain/feelings-chat/feelings-chat-bank";
import { getMessages } from "@/i18n/get-messages";
import { JagaOnApp } from "../JagaOnApp";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const en = getMessages("en-SG");
const t = en.feelingsChat;
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

type Row = { recordType: string; recordId: string; revisionId: string; revision: { payload: Record<string, unknown> } };

const FIRST = "Feeling tired and a bit worried today.";
const Q1 = "What has been making you feel tired lately?";
const Q2 = "What has been keeping you up at night?";
const A1 = "Not getting enough sleep, only 4 hours a night.";
const A2 = "Thinking about my son and his job.";
const SUMMARY = "Feeling tired; sleeping about 4 hours a night because of worry about family.";
const DOCTOR = "I've only been sleeping about 4 hours a night. Could this affect my diabetes?";
const ask = (question: string): FakeFeelingsChatStep => ({ candidate: { kind: "QUESTION", question, summary: null, doctorQuestion: null, themes: [], end: false } });
const wrap = (doctorQuestion: string | null): FakeFeelingsChatStep => ({ candidate: { kind: "WRAP_UP", question: null, summary: SUMMARY, doctorQuestion, themes: ["SLEEP", "FAMILY"], end: true } });

/**
 * Tell JagaOn understands more (owner decision 2026-10-14, design §3.1 steps 3–7): in the real app, the Feeling card's "Talk it through"
 * opens the feelings chat; the chat ends in one PERSONAL_NOTE (and, when she adds it, one CARE_QUESTION linked to the next appointment
 * and to the note); distress in the chat shows the voice distress message and saves nothing; the AI credit limit shows its dialog once.
 */
async function setup(script: readonly FakeFeelingsChatStep[]) {
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
  const port = createFakeFeelingsChatPort(script);
  const fake = createFakeVoiceTranscriber({ segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: FIRST }] });
  render(
    <JagaOnApp
      runtimeFactory={(_name?: string, options?: BrowserJournalRuntimeOptions) => createBrowserJournalRuntime(name, { ...options, now: () => PACKET10_NOW })}
      onboardingRepositoryFactory={() => createDemoOnboardingRepository(createMemoryOnboardingStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }))}
      appointmentNoteStorageFactory={() => createMemoryOnboardingStorage({})}
      voiceTranscriberLoader={async () => fake}
      voiceAvailabilityProbe={async () => true}
      feelingsChatPortFactory={() => port}
    />,
  );
  const entry = await screen.findByRole("button", { name: en.voice.entry }, { timeout: 30_000 });
  await waitFor(() => expect(entry).not.toBeDisabled(), { timeout: 30_000 });
  fireEvent.click(entry);
  fireEvent.change(await screen.findByLabelText(en.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
  fireEvent.click(screen.getByRole("button", { name: en.voice.disclosure.accept }));
  await waitFor(() => expect(screen.getByRole("button", { name: en.voice.state.stop })).not.toBeDisabled());
  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole("button", { name: en.voice.state.stop }));
  const [card] = (await screen.findAllByRole("article", {}, { timeout: 30_000 })) as HTMLElement[];
  expect(within(card!).getByRole("heading", { name: en.voice.feeling.heading })).toBeInTheDocument();
  return { name, port, card: card!, newRows: () => rowsAfter(before) };
}

const dialog = () => screen.getByRole("dialog");
const button = (name: string) => within(dialog()).getByRole("button", { name });
async function answer(text: string) {
  fireEvent.change(within(dialog()).getByRole("textbox", { name: t.answerLabel }), { target: { value: text } });
  fireEvent.click(button(t.send));
}

describe("Tell JagaOn: talk a feeling through with JagaOn (app wiring)", () => {
  it(
    "Talk it through → notice → two AI questions → wrap-up (edited) → Add to my questions → Save note: one note linked to one care question",
    async () => {
      const { name, port, card, newRows } = await setup([ask(Q1), ask(Q2), wrap(DOCTOR)]);
      fireEvent.click(within(card).getByRole("button", { name: en.voice.feeling.talkItThrough }));
      expect(dialog()).toHaveAccessibleDescription(t.notice);
      expect(port.requests()).toHaveLength(0);
      fireEvent.click(button(t.continue));
      expect(await within(dialog()).findByText(Q1)).toBeInTheDocument();
      expect(within(dialog()).getByText(KIND_SENTENCES.TIRED)).toBeInTheDocument();
      await answer(A1);
      expect(await within(dialog()).findByText(Q2)).toBeInTheDocument();
      await answer(A2);
      const summary = await within(dialog()).findByRole("textbox", { name: t.summaryLabel });
      fireEvent.change(summary, { target: { value: "Feeling tired; sleeping about 4 hours because of worry about my son." } });
      expect(within(dialog()).getByRole("textbox", { name: t.doctorQuestionTitle })).toHaveValue(DOCTOR);
      fireEvent.click(button(t.addToQuestions));
      expect(await within(dialog()).findAllByText(t.questionAdded)).not.toHaveLength(0);
      fireEvent.click(button(t.saveNote));
      expect(await within(dialog()).findByText(t.saved, {}, { timeout: 30_000 })).toBeInTheDocument();

      // Only her words and JagaOn's questions went to the port.
      expect(port.requests().map((request) => request.turn)).toEqual([1, 2, 3]);
      expect(port.requests()[2]!.messages).toEqual([
        { role: "patient", text: FIRST },
        { role: "jagaon_question", text: Q1 },
        { role: "patient", text: A1 },
        { role: "jagaon_question", text: Q2 },
        { role: "patient", text: A2 },
      ]);

      const rows = await newRows();
      expect(rows.map((row) => row.recordType).sort()).toEqual(["CARE_QUESTION", "PERSONAL_NOTE"]);
      const question = rows.find((row) => row.recordType === "CARE_QUESTION");
      const note = rows.find((row) => row.recordType === "PERSONAL_NOTE");
      expect(note!.revision.payload).toEqual({
        text: "Feeling tired; sleeping about 4 hours because of worry about my son.",
        language: "en-SG",
        feelingCues: ["tired", "worried"],
        turns: [
          { role: "PATIENT", text: FIRST, source: "PATIENT" },
          { role: "JAGAON_KIND_SENTENCE", text: KIND_SENTENCES.TIRED, source: "REVIEWED_BANK" },
          { role: "JAGAON_QUESTION", text: Q1, source: "AI_VALIDATED" },
          { role: "PATIENT", text: A1, source: "PATIENT" },
          { role: "JAGAON_QUESTION", text: Q2, source: "AI_VALIDATED" },
          { role: "PATIENT", text: A2, source: "PATIENT" },
        ],
        themes: ["SLEEP", "FAMILY"],
        aiUsed: true,
        promptVersion: "feelings-chat-prompt.1",
        careQuestionRef: { recordType: "CARE_QUESTION", recordId: question!.recordId, revisionId: question!.revisionId },
      });
      expect(question!.revision.payload).toMatchObject({ questionText: { text: DOCTOR, language: "und" } });

      // The question is in Prepare for my appointment (unticked: selection is the screen's), linked to the next appointment.
      const reader = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW });
      const visit = await reader.careOrganisation.query.loadVisitPreparation();
      reader.close();
      expect(visit.status).toBe("READY");
      if (visit.status !== "READY") return;
      expect(visit.appointment).not.toBeNull();
      expect(visit.questions.find((entry) => entry.recordId === question!.recordId)).toMatchObject({ text: DOCTOR, relatedAppointment: visit.appointment!.recordId });

      // Done: the Feeling card shows it saved, so it cannot be saved a second time.
      fireEvent.click(button(t.done));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(within(card).getByText(en.voice.feeling.savedToNotes)).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: en.voice.feeling.saveAsNote })).toBeNull();
      expect(within(card).queryByRole("button", { name: en.voice.feeling.talkItThrough })).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "Save as a note without AI: her words and the kind sentence, aiUsed false, no care question; nothing is sent",
    async () => {
      const { port, card, newRows } = await setup([ask(Q1)]);
      fireEvent.click(within(card).getByRole("button", { name: en.voice.feeling.talkItThrough }));
      fireEvent.click(button(t.saveWithoutAi));
      expect(await within(dialog()).findByText(t.saved, {}, { timeout: 30_000 })).toBeInTheDocument();
      expect(port.requests()).toHaveLength(0);
      const rows = await newRows();
      expect(rows.map((row) => row.recordType)).toEqual(["PERSONAL_NOTE"]);
      expect(rows[0]!.revision.payload).toEqual({
        text: FIRST,
        language: "en-SG",
        feelingCues: ["tired", "worried"],
        turns: [
          { role: "PATIENT", text: FIRST, source: "PATIENT" },
          { role: "JAGAON_KIND_SENTENCE", text: KIND_SENTENCES.TIRED, source: "REVIEWED_BANK" },
        ],
        themes: [],
        aiUsed: false,
        promptVersion: null,
        careQuestionRef: null,
      });
      fireEvent.click(button(t.done));
      await waitFor(() => expect(within(card).getByText(en.voice.feeling.savedToNotes)).toBeInTheDocument());
    },
    TIMEOUT,
  );

  it(
    "a distress answer mid-chat closes the chat and shows the voice distress message; no note, no care question, the card is gone",
    async () => {
      const { port, newRows } = await setup([ask(Q1), ask(Q2), wrap(DOCTOR)]);
      fireEvent.click(screen.getByRole("button", { name: en.voice.feeling.talkItThrough }));
      fireEvent.click(button(t.continue));
      await within(dialog()).findByText(Q1);
      await answer("I just want to end it all");
      const heading = await screen.findByRole("heading", { name: en.voice.distress.message });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("alert")).toContainElement(heading);
      await waitFor(() => expect(heading).toHaveFocus());
      expect(screen.getByText(en.voice.distress.trustedPerson)).toBeInTheDocument();
      expect(screen.queryByRole("article")).toBeNull();
      // The distress answer was never sent; nothing was stored.
      expect(port.requests()).toHaveLength(1);
      expect(JSON.stringify(port.requests())).not.toMatch(/end it all/);
      expect(await newRows()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "the AI credit limit: the credit dialog once (the chat waits for OK), then the bank's questions; a later limited turn shows no second dialog",
    async () => {
      const { port, card } = await setup([{ unavailable: "SPEND_CEILING_REACHED" }, { unavailable: "OPERATIONAL_SPEND_LOCKED" }]);
      fireEvent.click(within(card).getByRole("button", { name: en.voice.feeling.talkItThrough }));
      fireEvent.click(screen.getByRole("button", { name: t.continue }));
      const credit = await screen.findByRole("dialog", { name: en.aiCreditLimit.title });
      expect(credit).toHaveAccessibleDescription(en.aiCreditLimit.feelingsChatBody);
      expect(within(credit).getByRole("button", { name: en.aiCreditLimit.ok })).toHaveFocus();
      expect(screen.queryByText(FALLBACK_QUESTIONS[0]!)).toBeNull();
      fireEvent.click(within(credit).getByRole("button", { name: en.aiCreditLimit.ok }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: en.aiCreditLimit.title })).toBeNull());
      expect(await screen.findByText(FALLBACK_QUESTIONS[0]!)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("textbox", { name: t.answerLabel })).toHaveFocus());
      expect(screen.getByText(t.creditLimitNotice)).toBeInTheDocument();
      await answer("Work has been busy.");
      expect(await screen.findByText(FALLBACK_QUESTIONS[1]!)).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: en.aiCreditLimit.title })).toBeNull();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(port.interventions()).toMatchObject({ requests: 2, unavailable: 2 });
    },
    TIMEOUT,
  );

  it(
    "owner decision 2026-10-14: the rules drop the AI's doctor question; the AI summary is still saved, with no care question",
    async () => {
      const { card, newRows } = await setup([ask(Q1), ask(Q2), wrap("Should I reduce my insulin before bed?")]);
      fireEvent.click(within(card).getByRole("button", { name: en.voice.feeling.talkItThrough }));
      fireEvent.click(button(t.continue));
      await within(dialog()).findByText(Q1);
      await answer(A1);
      await within(dialog()).findByText(Q2);
      await answer(A2);
      expect(await within(dialog()).findByRole("textbox", { name: t.summaryLabel })).toHaveValue(SUMMARY);
      expect(within(dialog()).queryByText(/insulin/)).toBeNull();
      expect(within(dialog()).getByRole("textbox", { name: FALLBACK_QUESTIONS[2] })).toHaveValue("");
      fireEvent.click(button(t.saveNote));
      expect(await within(dialog()).findByText(t.saved, {}, { timeout: 30_000 })).toBeInTheDocument();
      const rows = await newRows();
      expect(rows.map((row) => row.recordType)).toEqual(["PERSONAL_NOTE"]);
      expect(rows[0]!.revision.payload).toMatchObject({ text: SUMMARY, themes: ["SLEEP", "FAMILY"], aiUsed: true, promptVersion: "feelings-chat-prompt.1", careQuestionRef: null });
    },
    TIMEOUT,
  );
});
