// @vitest-environment jsdom
// jsdom is deliberate: a React screen over the real journal and terminology services (fake IndexedDB), like the existing screen and
// storage tests. Synthetic data only; the transcriber is the scripted fake (no microphone, network or provider).
import Dexie from "dexie";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeVoiceTranscriber } from "@/application/voice/fake-voice-transcriber";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createTerminologyService } from "@/application/terminology/terminology-service";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import type { JagaOnDatabase } from "@/storage/database";
import { TellJagaOnScreen } from "./TellJagaOnScreen";
import { createVoiceJournalSave } from "./voice-journal-save";
import { VOICE_SCREEN_PENDING_COPY } from "./voice-screen-copy";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASSCODE = "TEST-ONLY-voice-passcode";
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});
const uuid = () => crypto.randomUUID();
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid } as never;

type Row = { recordType: string; revisionId: string; revision: { payload: Record<string, unknown> } };
const rowsOf = async (database: JagaOnDatabase, recordType: string) => ((await database.table("recordRevisions").toArray()) as Row[]).filter((row) => row.recordType === recordType);

function mount(database: JagaOnDatabase, deletion: Parameters<typeof createTerminologyService>[1]["deletion"], locale: SupportedLocale, text: string) {
  const terminology = createTerminologyService(database, { now: () => PACKET10_NOW, ids, deletion });
  const journal = createJournalCommandService(database, { now: () => PACKET10_NOW, ids });
  const onSaveFacts = createVoiceJournalSave({ commands: journal, recordMedicationEvent: journal.recordMedicationEvent, now: () => PACKET10_NOW });
  const fake = createFakeVoiceTranscriber({ segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text }] });
  render(<TellJagaOnScreen messages={getMessages(locale)} locale={locale} loadTranscriber={async () => fake} terminology={terminology} glucoseEntryUnit="MMOL_PER_L" onSaveFacts={onSaveFacts} onManualEntry={() => undefined} onClose={() => undefined} />);
  return { terminology };
}

async function speak(locale: SupportedLocale) {
  const messages = getMessages(locale);
  fireEvent.change(screen.getByLabelText(messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
  fireEvent.click(screen.getByRole("button", { name: messages.voice.disclosure.accept }));
  await waitFor(() => expect(screen.getByRole("button", { name: messages.voice.state.stop })).not.toBeDisabled());
  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole("button", { name: messages.voice.state.stop }));
  return (await screen.findAllByRole("article")) as HTMLElement[];
}

async function saveCard(card: HTMLElement, locale: SupportedLocale) {
  const copy = VOICE_SCREEN_PENDING_COPY[locale].card;
  fireEvent.click(within(card).getByRole("button", { name: copy.save }));
  await waitFor(() => expect(within(card).getByText(copy.saved)).toBeInTheDocument());
}

describe("Tell JagaOn end to end over the real journal (fake transcriber)", () => {
  for (const [locale, utterance, phrase, reuse] of [
    ["en-SG", "My sugar was 6.8 mmol, I had chicken rice for lunch and I injected my dark pen", "dark pen", "I injected my dark pen"],
    ["zh-SG", "血糖六点八毫摩尔，我午饭吃了鸡饭，然后打了黑色的笔", "黑色的笔", "我打了黑色的笔"],
  ] as const) {
    it(
      `${locale}: multi-fact → clarification → explicit remember → per-fact confirmation → journal saves → reuse after reload`,
      async () => {
        const { name, runtime } = await createPopulatedDataset();
        names.push(name);
        let database = await openRaw(name);
        const copy = VOICE_SCREEN_PENDING_COPY[locale].card;
        const existing = new Set(((await database.table("recordRevisions").toArray()) as Row[]).map((row) => row.revisionId));
        const added = async (recordType: string) => (await rowsOf(database, recordType)).filter((row) => !existing.has(row.revisionId));
        const before = { events: (await rowsOf(database, "MEDICATION_EVENT")).length };
        const { terminology } = mount(database, runtime.recordDeletion, locale, utterance);
        const [medicine] = await terminology.activeMedicines();
        const medicineName = medicine!.names[0]!;

        const cards = await speak(locale);
        expect(cards).toHaveLength(3);
        await saveCard(cards[0]!, locale);
        await saveCard(cards[1]!, locale);
        // Clarify the unknown phrase, remember it (separately), then confirm the occurrence.
        fireEvent.click(within(cards[2]!).getByRole("button", { name: copy.chooseMedicine }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByLabelText(medicineName));
        fireEvent.click(within(dialog).getByLabelText(copy.rememberLabel(phrase, medicineName)));
        fireEvent.click(within(dialog).getByRole("button", { name: copy.chooseMedicine }));
        await waitFor(() => expect(within(cards[2]!).getByText(copy.remembered)).toBeInTheDocument());
        expect((await rowsOf(database, "MEDICATION_EVENT")).length).toBe(before.events);
        await saveCard(cards[2]!, locale);

        const glucose = await added("GLUCOSE_READING");
        expect(glucose.map((row) => row.revision.payload.measurement)).toEqual([{ enteredValue: "6.8", enteredUnit: "MMOL_L", normalization: null }]);
        const meals = await added("INTAKE_EVENT");
        expect(meals.map((row) => [row.revision.payload.intakeSlot, row.revision.payload.items])).toEqual([[{ kind: "STANDARD_MEAL", code: "LUNCH" }, [{ kind: "UNKNOWN", label: locale === "en-SG" ? "chicken rice" : "鸡饭" }]]]);
        const events = await added("MEDICATION_EVENT");
        expect(events.map((row) => [row.revision.payload.state, (row.revision.payload.medication as { recordId: string }).recordId, row.revision.payload.amountTaken])).toEqual([["TAKEN", medicine!.medication.recordId, { kind: "NOT_RECORDED" }]]);
        expect((await terminology.list()).map((term) => term.phrase)).toEqual([phrase]);

        // Reload: a new screen over a reopened database reuses the term with no question; the fact still needs its own Save.
        cleanup();
        database.close();
        database = await openRaw(name);
        mount(database, runtime.recordDeletion, locale, reuse);
        const [card] = await speak(locale);
        expect(within(card!).getByText(medicineName)).toBeInTheDocument();
        expect(within(card!).queryByRole("button", { name: copy.chooseMedicine })).toBeNull();
        expect((await rowsOf(database, "MEDICATION_EVENT")).length).toBe(before.events + 1);
        await saveCard(card!, locale);
        expect((await rowsOf(database, "MEDICATION_EVENT")).length).toBe(before.events + 2);
        database.close();
        runtime.close();
      },
      TIMEOUT,
    );
  }
});
