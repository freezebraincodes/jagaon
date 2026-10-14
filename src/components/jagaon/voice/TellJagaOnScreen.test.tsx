// @vitest-environment jsdom
// The jsdom environment is deliberate: this is a React component test, like every existing screen test. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import type { VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import type { VoiceCandidate, VoiceMedicationRef } from "@/domain/voice/voice-contracts";
import { normaliseVoicePhrase } from "@/domain/voice/voice-candidate-extractor";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { TellJagaOnScreen, type TellJagaOnScreenProps, type VoiceTerminologyPort } from "./TellJagaOnScreen";
import { VOICE_SCREEN_PENDING_COPY } from "./voice-screen-copy";

const DARK: VoiceMedicationRef = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" };
const GREY: VoiceMedicationRef = { recordType: "MEDICATION", recordId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", revisionId: "2b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d" };
const PASSCODE = "TEST-ONLY-voice-passcode";

type FakeTerm = { recordId: string; revisionId: string; language: "en" | "zh"; phrase: string; medication: VoiceMedicationRef };
function fakeTerminology(): VoiceTerminologyPort & { terms: FakeTerm[]; remember: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn>; change: ReturnType<typeof vi.fn> } {
  const terms: FakeTerm[] = [];
  let next = 0;
  const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  const medicines = [
    { medication: DARK, names: ["Lantus (demo)"] },
    { medication: GREY, names: ["Apidra (demo)"] },
  ];
  return {
    terms,
    directory: async (language) => ({ terms: terms.filter((term) => term.language === language).map(({ phrase, medication }) => ({ phrase, medication })), names: medicines.flatMap((entry) => entry.names.map((name) => ({ name, medication: entry.medication }))) }),
    activeMedicines: async () => medicines,
    remember: vi.fn(async ({ language, phrase, medication }) => {
      terms.push({ recordId: id(), revisionId: id(), language, phrase: normaliseVoicePhrase(phrase, language), medication });
      return { kind: "COMMITTED" };
    }),
    list: async () => terms.map((term) => ({ ...term })),
    forget: vi.fn(async ({ recordId }: { recordId: string }) => {
      const index = terms.findIndex((term) => term.recordId === recordId);
      if (index < 0) return { kind: "REFUSED" };
      terms.splice(index, 1);
      return { kind: "FORGOTTEN" };
    }),
    change: vi.fn(async ({ recordId, expectedRevisionId, medication }: { recordId: string; expectedRevisionId: string; medication: VoiceMedicationRef }) => {
      const term = terms.find((entry) => entry.recordId === recordId);
      if (!term) return { kind: "REJECTED", code: "TERM_NOT_FOUND" };
      if (term.revisionId !== expectedRevisionId) return { kind: "REJECTED", code: "HEAD_CONFLICT" };
      term.medication = medication;
      term.revisionId = id();
      return { kind: "COMMITTED" };
    }),
  };
}

type Setup = Partial<TellJagaOnScreenProps> & { locale?: SupportedLocale; script?: FakeVoiceTranscriberScript; text?: string };

function setup({ locale = "en-SG", script, text, ...overrides }: Setup = {}) {
  const fake = createFakeVoiceTranscriber(script ?? { segmentsOnStart: text === undefined ? [] : [{ kind: "FINAL", segmentId: "s1", text }] });
  const loadTranscriber = vi.fn(async (passcode: () => string | null) => {
    expect(passcode()).toBe(PASSCODE);
    return fake;
  });
  const terminology = fakeTerminology();
  const onSaveFacts = vi.fn(async (intent: VoiceSaveIntent) => (void intent, { kind: "SAVED" as const }));
  const onManualEntry = vi.fn();
  const onClose = vi.fn();
  const props: TellJagaOnScreenProps = { messages: getMessages(locale), locale, loadTranscriber, terminology, glucoseEntryUnit: null, onSaveFacts, onManualEntry, onClose, ...overrides };
  const view = render(<TellJagaOnScreen {...props} />);
  return { fake, loadTranscriber, terminology, onSaveFacts, onManualEntry, onClose, view, messages: getMessages(locale), pending: VOICE_SCREEN_PENDING_COPY[locale] };
}

async function speakAndStop(context: ReturnType<typeof setup>) {
  const voice = context.messages.voice;
  fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
  fireEvent.click(screen.getByRole("button", { name: voice.disclosure.accept }));
  await waitFor(() => expect(screen.getByRole("button", { name: voice.state.stop })).not.toBeDisabled());
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: voice.state.stop }));
}

afterEach(() => cleanup());

describe("Tell JagaOn screen", () => {
  for (const [locale, text, value] of [["en-SG", "My sugar was 6.8 mmol", "6.8"], ["zh-SG", "血糖六点八毫摩尔", "6.8"]] as const) {
    it(`${locale}: an explicitly confirmed reading is saved exactly once with the spoken value and unit`, async () => {
      const context = setup({ locale, text });
      await speakAndStop(context);
      const save = await screen.findByRole("button", { name: context.pending.card.save });
      expect(screen.getByText(context.pending.card.unitSpoken)).toBeInTheDocument();
      fireEvent.click(save);
      await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
      fireEvent.click(save);
      expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
      expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: value, unit: "MMOL_PER_L", unitSource: "SPOKEN" });
      // The transcript is shown as not saved.
      expect(screen.getByText(context.messages.voice.review.transcriptLabel)).toBeInTheDocument();
    });
  }

  it("a reading with no unit needs an explicit unit tick; an app-default unit is labelled as such", async () => {
    const context = setup({ text: "Sugar reading 9.2" });
    await speakAndStop(context);
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText(context.pending.card.confirmUnit));
    fireEvent.click(save);
    await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "9.2", unit: "MMOL_PER_L", unitSource: "PERSON" }));
    cleanup();
    const defaulted = setup({ locale: "zh-SG", text: "血糖9.2", glucoseEntryUnit: "MMOL_PER_L" });
    await speakAndStop(defaulted);
    expect(await screen.findByText(defaulted.pending.card.unitAppDefault)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: defaulted.pending.card.save }));
    await waitFor(() => expect(defaulted.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "9.2", unit: "MMOL_PER_L", unitSource: "APP_DEFAULT" }));
  });

  for (const [locale, text] of [["en-SG", "My sugar was not 6.8 mmol"], ["zh-SG", "血糖不是六点八毫摩尔"], ["en-SG", "My sugar was below 4 mmol"], ["en-SG", "My sugar at 9 was 6.8 mmol"]] as const) {
    it(`${locale}: "${text}" cannot be saved as proposed; the edit is never prefilled (review M5)`, async () => {
      const context = setup({ locale, text });
      await speakAndStop(context);
      const cards = await screen.findAllByRole("article");
      const card = cards[0]!;
      expect(within(card).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.edit }));
      const input = within(card).getByLabelText(context.pending.card.valueLabel) as HTMLInputElement;
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: "8.6" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "8.6", unit: "MMOL_PER_L", unitSource: "PERSON" }));
    });
  }

  it("another person's reading is never saved here; manual entry is offered", async () => {
    const context = setup({ text: "my wife's sugar was 9.1 mmol" });
    await speakAndStop(context);
    const card = (await screen.findAllByRole("article"))[0]!;
    expect(within(card).getByText(context.pending.card.otherPerson)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: context.pending.card.save })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: context.pending.card.manualGlucose }));
    expect(context.onManualEntry).toHaveBeenCalledWith("GLUCOSE");
    expect(context.onSaveFacts).not.toHaveBeenCalled();
  });

  it("discard and leave-out never save", async () => {
    const context = setup({ text: "My sugar was 6.8 mmol" });
    await speakAndStop(context);
    fireEvent.click(await screen.findByRole("button", { name: context.pending.card.leaveOut }));
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
    expect(await screen.findByText(context.messages.voice.state.cancelled)).toBeInTheDocument();
    expect(context.onSaveFacts).not.toHaveBeenCalled();
  });

  it("cancel while listening releases the microphone, drops late results and saves nothing", async () => {
    const context = setup({ script: { release: "AUTO" } });
    fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.accept }));
    await waitFor(() => expect(screen.getByRole("button", { name: context.messages.voice.state.stop })).not.toBeDisabled());
    act(() => context.fake.emit({ kind: "INTERIM", segmentId: "s1", text: "my sugar" }));
    expect(screen.getByText("my sugar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.state.cancel }));
    expect(await screen.findByText(context.messages.voice.state.cancelled)).toBeInTheDocument();
    act(() => context.fake.emit({ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }));
    expect(screen.queryByText("My sugar was 6.8 mmol")).toBeNull();
    expect(context.fake.calls).toEqual(["start:en", "cancel", "release"]);
    expect(context.onSaveFacts).not.toHaveBeenCalled();
  });

  it("a provider failure, a refused passcode and a denied microphone each offer manual entry", async () => {
    for (const [script, text] of [
      [{ start: { kind: "FAILED", reason: "PERMISSION_DENIED" } }, getMessages("en-SG").voice.state.permissionDenied],
      [{ start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" } }, VOICE_SCREEN_PENDING_COPY["en-SG"].state.accessDenied],
      [{ start: { kind: "FAILED", reason: "PROVIDER_FAILURE" } }, getMessages("en-SG").voice.state.unavailable],
    ] as const) {
      const context = setup({ script: script as FakeVoiceTranscriberScript });
      fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.accept }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: context.pending.review.backToToday }));
      expect(context.onClose).toHaveBeenCalledTimes(1);
      expect(context.onManualEntry).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("unsupported speech is shown as not understood, never dropped, with manual entry", async () => {
    const context = setup({ locale: "zh-SG", text: "血糖六点八毫摩尔，我昨天下午有点头晕" });
    await speakAndStop(context);
    expect(await screen.findByText(context.pending.review.notUnderstoodHeading)).toBeInTheDocument();
    expect(screen.getByText("“我昨天下午有点头晕”")).toBeInTheDocument();
  });

  // Finding V-2 Option 0 (owner-approved 2026-10-10): words JagaOn cannot capture are listed exactly as said under "Not captured",
  // never saved or interpreted; the reading-specific guidance stays on the affected reading card, and the save gate is unchanged.
  for (const [locale, withReading, wordsOnly, span] of [
    ["en-SG", "My sugar was 6.8 mmol, I felt dizzy", "I felt dizzy", "I felt dizzy"],
    ["zh-SG", "血糖六点八毫摩尔，我昨天下午有点头晕", "我昨天下午有点头晕", "我昨天下午有点头晕"],
  ] as const) {
    it(`${locale}: V-2 next to a reading: "Not captured" lists the words; the reading card keeps its own typing guidance and cannot be saved in one tap`, async () => {
      const context = setup({ locale, text: withReading });
      await speakAndStop(context);
      const heading = await screen.findByRole("heading", { name: context.pending.review.notUnderstoodHeading });
      const section = heading.closest("section") as HTMLElement;
      expect(context.pending.review.notUnderstoodHeading).toBe(locale === "en-SG" ? "Not captured" : "未记录的内容");
      expect(within(section).getByText(context.pending.review.notUnderstoodBody)).toBeInTheDocument();
      expect(within(section).getByText(`“${span}”`)).toBeInTheDocument();
      expect(section).not.toHaveTextContent(context.pending.card.needsEdit);
      const card = screen.getAllByRole("article")[0]!;
      expect(within(card).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it(`${locale}: V-2 words alone: they are shown as not captured with no reading guidance, and nothing is saved`, async () => {
      const context = setup({ locale, text: wordsOnly });
      await speakAndStop(context);
      expect(await screen.findByText(`“${span}”`)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: context.pending.review.notUnderstoodHeading })).toBeInTheDocument();
      expect(screen.getByText(context.pending.review.notUnderstoodBody)).toBeInTheDocument();
      expect(screen.queryAllByRole("article")).toHaveLength(0);
      expect(screen.queryByText(context.pending.card.needsEdit)).toBeNull();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });
  }

  for (const [locale, text] of [["en-SG", "How many tablets should I take?"], ["zh-SG", "我应该吃几片药？"]] as const) {
    it(`${locale}: a dose question shows only the fixed redirect; nothing is saved or sent onward`, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const context = setup({ locale, text });
      await speakAndStop(context);
      expect((await screen.findAllByText(context.messages.voice.redirect.body)).length).toBeGreaterThan(0);
      expect(screen.getByText(context.messages.voice.redirect.transcribedNote)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: context.pending.card.save })).toBeNull();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  }

  // Owner decision 2026-10-14 (distress safety): only the calm safety message with helplines; nothing else, nothing saved or sent.
  describe("distress words (owner decision 2026-10-14)", () => {
    const LINKS = [
      ["SOS (Samaritans of Singapore): call 1767", "tel:1767"],
      ["or WhatsApp 9151 1767", "https://wa.me/6591511767"],
      ["mindline: call 1771", "tel:1771"],
      ["or WhatsApp 6669 1771", "https://wa.me/6566691771"],
      ["If you're in immediate danger, call 995", "tel:995"],
    ] as const;

    for (const text of ["I don't want to live anymore", "Please help me, I can't go on", "I want to kill myself, how much insulin should I take", "My sugar was 6.8 mmol, I had chicken rice for lunch and I want to end it all"]) {
      it(`"${text}" shows only the safety message with the five helpline links; no card, transcript, redirect, not-captured list or save`, async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const remoteExtraction = vi.fn();
        const context = setup({ text, remoteExtraction });
        await speakAndStop(context);
        const distress = context.messages.voice.distress;
        const heading = await screen.findByRole("heading", { name: distress.message });
        expect(distress.message).toBe("It sounds like you're going through something really hard. You don't have to face it alone. Please reach out now:");
        expect(heading.closest('[role="alert"]')).not.toBeNull();
        await waitFor(() => expect(heading).toHaveFocus());
        const section = heading.closest("section") as HTMLElement;
        const links = within(section).getAllByRole("link");
        expect(links.map((link) => link.getAttribute("href"))).toEqual(LINKS.map(([, href]) => href));
        for (const [name, href] of LINKS) expect(within(section).getByRole("link", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) })).toHaveAttribute("href", href);
        for (const href of ["https://wa.me/6591511767", "https://wa.me/6566691771"]) expect(links.find((link) => link.getAttribute("href") === href)).toHaveAttribute("target", "_blank");
        expect(within(section).getByText("24 hours")).toBeInTheDocument();
        expect(within(section).getByText("round the clock")).toBeInTheDocument();
        expect(within(section).getByText("You can also talk to someone you trust.")).toBeInTheDocument();
        // Nothing else: no transcript, card, not-captured list, redirect, manual chooser, remote offer or remembered words.
        expect(screen.queryByText(context.messages.voice.review.transcriptLabel)).toBeNull();
        expect(screen.queryByText(text)).toBeNull();
        expect(screen.queryAllByRole("article")).toHaveLength(0);
        expect(screen.queryByText(context.pending.review.notUnderstoodHeading)).toBeNull();
        expect(screen.queryByText(context.pending.review.notUnderstoodBody)).toBeNull();
        expect(screen.queryByText(context.messages.voice.redirect.body)).toBeNull();
        expect(screen.queryByText(context.pending.redirect.healthBody)).toBeNull();
        expect(screen.queryByText(context.messages.voice.redirect.transcribedNote)).toBeNull();
        expect(screen.queryByText(context.messages.voice.review.nothingFound)).toBeNull();
        expect(screen.queryByText(context.pending.review.manualHeading)).toBeNull();
        expect(screen.queryByRole("button", { name: context.pending.remote.offer })).toBeNull();
        expect(screen.queryByRole("button", { name: context.pending.card.save })).toBeNull();
        expect(screen.queryByRole("button", { name: context.messages.voice.review.discard })).toBeNull();
        expect(screen.getAllByRole("button")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: context.pending.review.backToToday }));
        expect(context.onClose).toHaveBeenCalledTimes(1);
        expect(context.onSaveFacts).not.toHaveBeenCalled();
        expect(context.onManualEntry).not.toHaveBeenCalled();
        expect(remoteExtraction).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });
    }

    it("zh-SG: English distress words in a Chinese session also show the safety message (draft Chinese copy)", async () => {
      const context = setup({ locale: "zh-SG", text: "血糖六点八，I want to die" });
      await speakAndStop(context);
      const heading = await screen.findByRole("heading", { name: context.messages.voice.distress.message });
      const links = within(heading.closest("section") as HTMLElement).getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual(LINKS.map(([, href]) => href));
      expect(screen.queryAllByRole("article")).toHaveLength(0);
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });
  });

  it("mixed content: the redirect stays visible beside a separately reviewable reading", async () => {
    const context = setup({ text: "sugar 15 mmol, how many units now" });
    await speakAndStop(context);
    expect(await screen.findByText(context.messages.voice.redirect.body)).toBeInTheDocument();
    expect(screen.queryByText(context.pending.redirect.healthBody)).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  for (const [locale, text] of [["en-SG", "Is a sugar of 15 dangerous?"], ["zh-SG", "血糖十五危险吗？"]] as const) {
    it(`${locale}: 13s.3 a health question shows the HEALTH wording (by category), never the dose wording; nothing is saved`, async () => {
      const context = setup({ locale, text });
      await speakAndStop(context);
      expect((await screen.findAllByText(context.pending.redirect.healthBody)).length).toBeGreaterThan(0);
      expect(screen.queryByText(context.messages.voice.redirect.body)).toBeNull();
      expect(screen.getByText(context.messages.voice.redirect.transcribedNote)).toBeInTheDocument();
      expect(screen.queryByRole("article")).toBeNull();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });
  }

  it("zh: 13s.3 a separated health question keeps the HEALTH wording beside the reading", async () => {
    const context = setup({ locale: "zh-SG", text: "我的血糖十五毫摩尔，这样危险吗？" });
    await speakAndStop(context);
    expect(await screen.findByText(context.pending.redirect.healthBody)).toBeInTheDocument();
    expect(screen.queryByText(context.messages.voice.redirect.body)).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("an unresolved medicine is clarified, remembered separately, saved only on its own Save, and reused next time", async () => {
    const context = setup({ text: "I injected my grey pen" });
    await speakAndStop(context);
    fireEvent.click(await screen.findByRole("button", { name: context.pending.card.chooseMedicine }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Apidra (demo)"));
    fireEvent.click(within(dialog).getByLabelText(context.pending.card.rememberLabel("grey pen", "Apidra (demo)")));
    fireEvent.click(within(dialog).getByRole("button", { name: context.pending.card.chooseMedicine }));
    await waitFor(() => expect(context.terminology.remember).toHaveBeenCalledWith({ language: "en", phrase: "grey pen", medication: GREY }));
    // Remembering records nothing.
    expect(context.onSaveFacts).not.toHaveBeenCalled();
    expect(await screen.findByText(context.pending.card.remembered)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: context.pending.card.save }));
    await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "MEDICATION_EVENT", medication: GREY, status: "TAKEN", reportedAmount: null }));

    // Next session (same profile): the remembered term is reused, no question; the fact still needs its own Save.
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
    fireEvent.click(await screen.findByRole("button", { name: context.messages.voice.entry }));
    await speakAndStop(context);
    expect(await screen.findByText("Apidra (demo)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: context.pending.card.chooseMedicine })).toBeNull();
    expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
  });

  it("owner #4: a reported amount is shown exactly as said, never as advice, and the card says plainly when it will not be saved", async () => {
    const context = setup({ text: "I injected 10 units of my grey pen" });
    await speakAndStop(context);
    expect(await screen.findByText(context.pending.card.amountReported("10 units"))).toBeInTheDocument();
    expect(screen.getByText(context.pending.card.amountNotSaved)).toBeInTheDocument();
    cleanup();
    // When the save path stores it (TAKEN), the card says plainly that it will be saved; the amount travels with the confirmed fact.
    const saving = setup({ text: "I injected 10 units of my grey pen", reportedAmountSaved: true });
    await speakAndStop(saving);
    expect(await screen.findByText(saving.pending.card.amountReported("10 units"))).toBeInTheDocument();
    expect(screen.getByText(saving.pending.card.amountWillBeSaved)).toBeInTheDocument();
    expect(screen.queryByText(saving.pending.card.amountNotSaved)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: saving.pending.card.chooseMedicine }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Apidra (demo)"));
    fireEvent.click(within(dialog).getByRole("button", { name: saving.pending.card.chooseMedicine }));
    fireEvent.click(await screen.findByRole("button", { name: saving.pending.card.save }));
    await waitFor(() => expect(saving.onSaveFacts).toHaveBeenCalledWith({ kind: "MEDICATION_EVENT", medication: GREY, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "units" } }));
  });

  it("13s.3: a reported amount is never stored on an edit, nor for a skipped or unclear dose; the card says so and offers manual entry", async () => {
    const editing = setup({ text: "I injected 10 units of my grey pen", reportedAmountSaved: true });
    await speakAndStop(editing);
    const card = (await screen.findAllByRole("article"))[0]!;
    expect(within(card).getByText(editing.pending.card.amountWillBeSaved)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: editing.pending.card.edit }));
    expect(within(card).getByText(editing.pending.card.amountNotSaved)).toBeInTheDocument();
    expect(within(card).queryByText(editing.pending.card.amountWillBeSaved)).toBeNull();
    fireEvent.change(within(card).getByLabelText(editing.pending.card.chooseMedicine), { target: { value: GREY.recordId } });
    fireEvent.change(within(card).getByLabelText(editing.pending.card.statusQuestion), { target: { value: "TAKEN" } });
    fireEvent.click(within(card).getByRole("button", { name: editing.pending.card.save }));
    await waitFor(() => expect(editing.onSaveFacts).toHaveBeenCalledWith({ kind: "MEDICATION_EVENT", medication: GREY, status: "TAKEN", reportedAmount: null }));
    cleanup();
    const skipped = setup({ text: "I skipped 10 units of my grey pen", reportedAmountSaved: true });
    await speakAndStop(skipped);
    const skippedCard = (await screen.findAllByRole("article"))[0]!;
    expect(within(skippedCard).getByText(skipped.pending.card.amountReported("10 units"))).toBeInTheDocument();
    expect(within(skippedCard).getByText(skipped.pending.card.amountNotSaved)).toBeInTheDocument();
    fireEvent.click(within(skippedCard).getByRole("button", { name: skipped.pending.card.manualMedicine }));
    expect(skipped.onManualEntry).toHaveBeenCalledWith("MEDICATION");
  });

  // CR-11 (owner decisions 2026-10-11, design v3.1): this replaces the 13s.3 OUT_OF_RANGE test (a 60 was refused; it now confirms).
  for (const [locale, digits, words, zero, unstated] of [
    ["en-SG", "My sugar was 60 mmol", "My sugar was sixty mmol", "sugar zero mmol", "My sugar was sixty"],
    ["zh-SG", "血糖60毫摩尔", "血糖六十毫摩尔", "血糖零毫摩尔", "血糖六十"],
  ] as const) {
    const panelOf = (card: HTMLElement, value: string) => within(card).getByRole("region", { name: `${value} mmol/L` });

    it(`${locale}: CR-11 AC-1 / AC-2 / AC-6: "${digits}" and "${words}" open the confirmation (60.0 mmol/L); Save as shown saves 60.0 once`, async () => {
      for (const text of [digits, words]) {
        const context = setup({ locale, text });
        await speakAndStop(context);
        const card = (await screen.findAllByRole("article"))[0]!;
        const panel = panelOf(card, "60.0");
        expect(within(panel).getByRole("heading", { name: "60.0 mmol/L" })).toBeInTheDocument();
        expect(within(panel).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
        expect(within(panel).getByText(context.pending.card.unitSpoken)).toBeInTheDocument();
        expect(within(panel).getAllByRole("button").map((button) => button.textContent)).toEqual([context.pending.card.saveAsShown, context.pending.card.editReading, context.pending.card.cancel]);
        expect(within(card).queryByRole("button", { name: context.pending.card.save })).toBeNull();
        expect(card.textContent).not.toMatch(/verified|已验证|核实无误|dangerous|危险|too high|过高/i);
        const saveAsShown = within(panel).getByRole("button", { name: context.pending.card.saveAsShown });
        fireEvent.click(saveAsShown);
        fireEvent.click(saveAsShown);
        await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent(context.pending.card.saved));
        expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
        expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "60.0", unit: "MMOL_PER_L", unitSource: "SPOKEN" });
        expect(within(card).queryByText(context.pending.card.confirmBody)).toBeNull();
        expect(within(card).getByText("60.0")).toBeInTheDocument();
        expect(within(card).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
        cleanup();
      }
    });

    it(`${locale}: CR-11 AC-3: the latch: Edit reading to 45 returns to the confirmation (focused); saved as 45.0`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
      const input = within(card).getByLabelText(context.pending.card.valueLabel) as HTMLInputElement;
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: "45" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      const panel = panelOf(card, "45.0");
      expect(within(panel).getByRole("heading", { name: "45.0 mmol/L" })).toHaveFocus();
      expect(within(panel).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      fireEvent.click(within(panel).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "45.0", unit: "MMOL_PER_L", unitSource: "PERSON" }));
      expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
    });

    it(`${locale}: CR-11 AC-4 / AC-5: Cancel writes nothing; the card stays unsaved; Save this opens the confirmation again`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.cancel }));
      expect(within(card).queryByRole("region")).toBeNull();
      expect(within(card).getByText("60.0")).toBeInTheDocument();
      expect(within(card).getByRole("status")).toHaveTextContent("");
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      expect(within(panelOf(card, "60.0")).getByRole("heading")).toHaveFocus();
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.leaveOut }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it(`${locale}: round 5 (revised B): a hedged reading always opens the confirmation with the number and unit; an unstated unit needs the tick; nothing saves before Save as shown`, async () => {
      const spoken = locale === "en-SG" ? "My sugar was about 7.8 mmol" : "血糖大约七点八毫摩尔";
      const context = setup({ locale, text: spoken, glucoseEntryUnit: "MMOL_PER_L" });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      const panel = panelOf(card, "7.8");
      expect(within(panel).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
      expect(within(panel).getByText(context.pending.card.unitSpoken)).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: context.pending.card.save })).toBeNull();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      fireEvent.click(within(panel).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "7.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" }));
      cleanup();
      const unstated = setup({ locale, text: locale === "en-SG" ? "sugar ~7" : "血糖七左右", glucoseEntryUnit: "MMOL_PER_L" });
      await speakAndStop(unstated);
      const unstatedCard = (await screen.findAllByRole("article"))[0]!;
      const unstatedPanel = panelOf(unstatedCard, "7.0");
      expect(within(unstatedPanel).queryByText(unstated.pending.card.unitAppDefault)).toBeNull();
      const saveAsShown = within(unstatedPanel).getByRole("button", { name: unstated.pending.card.saveAsShown });
      expect(saveAsShown).toBeDisabled();
      fireEvent.click(within(unstatedPanel).getByLabelText(unstated.pending.card.confirmUnit));
      fireEvent.click(saveAsShown);
      await waitFor(() => expect(unstated.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "7.0", unit: "MMOL_PER_L", unitSource: "PERSON" }));
      expect(unstated.onSaveFacts).toHaveBeenCalledTimes(1);
    });

    it(`${locale}: round 5 (revised B): the hedge latch survives Cancel and an edit to 6`, async () => {
      const context = setup({ locale, text: locale === "en-SG" ? "My sugar was about 7.8 mmol" : "血糖大约七点八毫摩尔" });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "7.8")).getByRole("button", { name: context.pending.card.cancel }));
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.edit }));
      fireEvent.change(within(card).getByLabelText(context.pending.card.valueLabel), { target: { value: "6" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      expect(within(panelOf(card, "6.0")).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
      await act(async () => {
        await Promise.resolve();
      });
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it(`${locale}: round 8: a signed medicine amount is never shown or saved as an amount; the card needs an edit (existing copy) and an edit saves no amount`, async () => {
      const text = locale === "en-SG" ? "I injected -2 units of my dark pen" : "我打了-2个单位的黑色的笔";
      const context = setup({ locale, text });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      expect(within(card).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
      expect(within(card).queryByText(context.pending.card.amountReported(locale === "en-SG" ? "2 units" : "2 个单位"))).toBeNull();
      expect(within(card).queryByText(context.pending.card.amountWillBeSaved)).toBeNull();
      expect(card.textContent).not.toMatch(/(?<![-−\d])2 (?:units|个单位)/);
      expect(within(card).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.edit }));
      fireEvent.change(within(card).getByLabelText(context.pending.card.chooseMedicine), { target: { value: DARK.recordId } });
      fireEvent.change(within(card).getByLabelText(context.pending.card.statusQuestion), { target: { value: "TAKEN" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: null }));
    });

    it(`${locale}: round 3 (ruling 5): a confirmation that is already open when the review appears does not take focus`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      const panel = panelOf(card, "60.0");
      await act(async () => {
        await Promise.resolve();
      });
      // Nothing moves focus when the review loads (the Stop control that had it is gone): focus stays on the document body, outside
      // the card and its panel; only the person's own action moves it to the panel heading (see the I-2 test).
      expect(panel.contains(document.activeElement)).toBe(false);
      expect(card.contains(document.activeElement)).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(within(panel).getByRole("heading", { name: "60.0 mmol/L" })).not.toHaveFocus();
    });

    it(`${locale}: fix round 1 I-2: focus goes to the edit field after Edit reading, to Save this after Cancel, and to the saved status after Save as shown`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
      expect(document.activeElement).toBe(within(card).getByLabelText(context.pending.card.valueLabel));
      fireEvent.change(within(card).getByLabelText(context.pending.card.valueLabel), { target: { value: "45" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      fireEvent.click(within(panelOf(card, "45.0")).getByRole("button", { name: context.pending.card.cancel }));
      expect(document.activeElement).toBe(within(card).getByRole("button", { name: context.pending.card.save }));
      expect(document.activeElement).not.toBe(document.body);
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent(context.pending.card.saved));
      expect(document.activeElement).toBe(within(card).getByRole("status"));
    });

    it(`${locale}: fix round 1 I-3 (M15): the latch survives Cancel: Cancel → Edit → 44 opens the confirmation for 44.0 mmol/L`, async () => {
      for (const viaEditedPanel of [false, true]) {
        const context = setup({ locale, text: digits });
        await speakAndStop(context);
        const card = (await screen.findAllByRole("article"))[0]!;
        if (viaEditedPanel) {
          fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
          fireEvent.change(within(card).getByLabelText(context.pending.card.valueLabel), { target: { value: "45" } });
          fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
          fireEvent.click(within(panelOf(card, "45.0")).getByRole("button", { name: context.pending.card.cancel }));
        } else {
          fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.cancel }));
        }
        fireEvent.click(within(card).getByRole("button", { name: context.pending.card.edit }));
        fireEvent.change(within(card).getByLabelText(context.pending.card.valueLabel), { target: { value: "44" } });
        fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
        expect(within(panelOf(card, "44.0")).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
        await act(async () => {
          await Promise.resolve();
        });
        expect(context.onSaveFacts).not.toHaveBeenCalled();
        cleanup();
      }
    });

    it(`${locale}: fix round 1 I-1: the card's field has no maxlength; a 7+ character paste is refused with the message and leaves the field unchanged`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
      const input = within(card).getByLabelText(context.pending.card.valueLabel) as HTMLInputElement;
      expect(input).not.toHaveAttribute("maxlength");
      fireEvent.change(input, { target: { value: "1234.56" } });
      expect(input.value).toBe("");
      expect(within(card).getByRole("alert")).toHaveTextContent(context.pending.card.valueFormatRefused);
      fireEvent.change(input, { target: { value: "123" } });
      expect(within(card).queryByRole("alert")).toBeNull();
      fireEvent.change(input, { target: { value: "1234.56" } });
      expect(input.value).toBe("123");
      expect(within(card).getByRole("alert")).toHaveTextContent(context.pending.card.valueFormatRefused);
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it(`${locale}: CR-11 AC-7: "${zero}" shows 0.0 mmol/L in the confirmation and saves 0.0 only after Save as shown`, async () => {
      const context = setup({ locale, text: zero });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      const panel = panelOf(card, "0.0");
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      fireEvent.click(within(panel).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "0.0", unit: "MMOL_PER_L", unitSource: "SPOKEN" }));
    });

    it(`${locale}: CR-11 AC-13: an unstated unit outside the window needs the explicit "Yes, mmol/L" (no default); inside it the default is labelled`, async () => {
      const context = setup({ locale, text: unstated, glucoseEntryUnit: "MMOL_PER_L" });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      const panel = panelOf(card, "60.0");
      expect(within(panel).queryByText(context.pending.card.unitAppDefault)).toBeNull();
      expect(within(panel).getByText(context.messages.voice.review.unitUnstated)).toBeInTheDocument();
      const yes = within(panel).getByLabelText(context.pending.card.confirmUnit) as HTMLInputElement;
      expect(yes.checked).toBe(false);
      const saveAsShown = within(panel).getByRole("button", { name: context.pending.card.saveAsShown });
      expect(saveAsShown).toBeDisabled();
      fireEvent.click(yes);
      fireEvent.click(saveAsShown);
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "60.0", unit: "MMOL_PER_L", unitSource: "PERSON" }));
      cleanup();
      const inside = setup({ locale, text: locale === "en-SG" ? "My sugar was thirty" : "血糖三十", glucoseEntryUnit: "MMOL_PER_L" });
      await speakAndStop(inside);
      expect(await screen.findByText(inside.pending.card.unitAppDefault)).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: /mmol\/L$/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: inside.pending.card.save }));
      await waitFor(() => expect(inside.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "30.0", unit: "MMOL_PER_L", unitSource: "APP_DEFAULT" }));
    });

    it(`${locale}: CR-11 AC-15: the meal saved first leaves the 60 card unsaved ("not been saved"); confirming later does not touch the meal`, async () => {
      const text = locale === "en-SG" ? "My sugar was 60 mmol, I had chicken rice for lunch" : "血糖60毫摩尔，我午饭吃了鸡饭";
      const context = setup({ locale, text });
      await speakAndStop(context);
      const [glucoseCard, mealCard] = await screen.findAllByRole("article");
      fireEvent.click(within(mealCard!).getByRole("button", { name: context.pending.card.save }));
      await waitFor(() => expect(within(mealCard!).getByRole("status")).toHaveTextContent(context.pending.card.saved));
      expect(within(panelOf(glucoseCard!, "60.0")).getByText(context.pending.card.confirmBody)).toBeInTheDocument();
      expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
      expect(context.onSaveFacts.mock.calls[0]![0]).toMatchObject({ kind: "MEAL" });
      fireEvent.click(within(panelOf(glucoseCard!, "60.0")).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledTimes(2));
      expect(context.onSaveFacts.mock.calls[1]![0]).toEqual({ kind: "GLUCOSE", valueText: "60.0", unit: "MMOL_PER_L", unitSource: "SPOKEN" });
      expect(within(mealCard!).getByRole("status")).toHaveTextContent(context.pending.card.saved);
    });

    it(`${locale}: CR-11 AC-9 / AC-10 / AC-11: the card's edit field refuses a second decimal digit (typed or pasted), never rounds; 1234.5 confirms`, async () => {
      const context = setup({ locale, text: digits });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(panelOf(card, "60.0")).getByRole("button", { name: context.pending.card.editReading }));
      const input = within(card).getByLabelText(context.pending.card.valueLabel) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "9.2" } });
      for (const pasted of ["9.25", "60.00", "6..5", "-5", "1e3", "060"]) {
        fireEvent.change(input, { target: { value: pasted } });
        expect(input.value, pasted).toBe("9.2");
        expect(within(card).getByRole("alert")).toHaveTextContent(context.pending.card.valueFormatRefused);
      }
      fireEvent.change(input, { target: { value: "9" } });
      fireEvent.blur(input);
      expect(input.value).toBe("9.0");
      fireEvent.focus(input);
      expect(input.value).toBe("9");
      fireEvent.change(input, { target: { value: "1234.5" } });
      fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
      fireEvent.click(within(panelOf(card, "1234.5")).getByRole("button", { name: context.pending.card.saveAsShown }));
      await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "1234.5", unit: "MMOL_PER_L", unitSource: "PERSON" }));
    });
  }

  it("13s.3 round 4: with a not-understood span the reading is not one-tap; it must be typed (never prefilled)", async () => {
    const context = setup({ text: "My sugar was 6.8 mmol, I felt dizzy", glucoseEntryUnit: "MMOL_PER_L" });
    await speakAndStop(context);
    const card = (await screen.findAllByRole("article"))[0]!;
    expect(screen.getByText(context.pending.review.notUnderstoodHeading)).toBeInTheDocument();
    expect(within(card).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
    expect(within(card).queryByText("6.8")).toBeNull();
    expect(within(card).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: context.pending.card.edit }));
    const input = within(card).getByLabelText(context.pending.card.valueLabel) as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "6.8" } });
    fireEvent.click(within(card).getByRole("button", { name: context.pending.card.save }));
    await waitFor(() => expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "PERSON" }));
  });

  it("a planned dose is not saved as an event", async () => {
    const context = setup({ locale: "zh-SG", text: "我需要打灰色的笔" });
    await speakAndStop(context);
    expect(await screen.findByText(context.pending.card.planned)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: context.pending.card.save })).toBeDisabled();
  });

  describe("optional remote extraction (DeepSeek, per-request disclosure, local floor)", () => {
    const REMOTE = { source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13r.1" } as const;
    const laksa = (text: string) => {
      const start = [...text.slice(0, text.indexOf("had laksa"))].length;
      const candidate: VoiceCandidate = { kind: "MEAL_NOTE", ...REMOTE, span: { start, end: start + 9 }, sourcePhrase: "had laksa", slot: "UNSTATED", itemText: "laksa", state: "UNDERSTOOD", ambiguity: [] };
      return candidate;
    };

    it("is never offered without the prop, nor for treatment-question content", async () => {
      const without = setup({ text: "My sugar was 6.8 mmol, I ate laksa" });
      await speakAndStop(without);
      await screen.findAllByRole("article");
      expect(screen.queryByRole("button", { name: without.pending.remote.offer })).toBeNull();
      cleanup();
      const remoteExtraction = vi.fn();
      const question = setup({ text: "sugar 15 mmol, how many units now", remoteExtraction });
      await speakAndStop(question);
      await screen.findAllByRole("article");
      expect(screen.queryByRole("button", { name: question.pending.remote.offer })).toBeNull();
      expect(remoteExtraction).not.toHaveBeenCalled();
    });

    it("declining its own disclosure sends nothing", async () => {
      const remoteExtraction = vi.fn();
      const context = setup({ text: "My sugar was 6.8 mmol, I ate laksa", remoteExtraction });
      await speakAndStop(context);
      fireEvent.click(await screen.findByRole("button", { name: context.pending.remote.offer }));
      expect(screen.getByRole("dialog")).toHaveTextContent(context.pending.remote.title);
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.decline }));
      expect(await screen.findByText(context.pending.remote.keptLocal)).toBeInTheDocument();
      expect(remoteExtraction).not.toHaveBeenCalled();
    });

    it("accepted: the transcript is sent once; remote facts are merged under the local floor; nothing is saved without Save", async () => {
      // Deliberately "had laksa": this case needs a locally not-understood span for the remote meal to fill. Round 4 also makes the
      // reading beside it need typing (UNCERTAINTY, no one-tap), asserted below.
      const text = "My sugar was 6.8 mmol, had laksa";
      const remoteExtraction = vi.fn(async () => ({ kind: "CANDIDATES" as const, candidates: [laksa(text)] }));
      const context = setup({ text, remoteExtraction });
      await speakAndStop(context);
      expect(await screen.findByText(context.pending.review.notUnderstoodHeading)).toBeInTheDocument();
      expect(within(screen.getAllByRole("article")[0]!).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.offer }));
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.accept }));
      await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
      expect(remoteExtraction).toHaveBeenCalledTimes(1);
      expect(remoteExtraction).toHaveBeenCalledWith(text, "en", expect.any(AbortSignal));
      expect(screen.queryByText(context.pending.review.notUnderstoodHeading)).toBeNull();
      expect(screen.getByText("laksa")).toBeInTheDocument();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it("zh: an unavailable remote keeps the local result", async () => {
      const remoteExtraction = vi.fn(async () => ({ kind: "UNAVAILABLE" as const }));
      const context = setup({ locale: "zh-SG", text: "血糖六点八毫摩尔，我昨天下午有点头晕", remoteExtraction });
      await speakAndStop(context);
      fireEvent.click(await screen.findByRole("button", { name: context.pending.remote.offer }));
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.accept }));
      expect(await screen.findByText(context.pending.remote.keptLocal)).toBeInTheDocument();
      expect(remoteExtraction).toHaveBeenCalledWith("血糖六点八毫摩尔，我昨天下午有点头晕", "zh", expect.any(AbortSignal));
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.getByText(context.pending.review.notUnderstoodHeading)).toBeInTheDocument();
    });

    it("is no longer offered once a fact was saved; unmount aborts a pending request", async () => {
      const remoteExtraction = vi.fn((_text: string, _language: string, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
      const context = setup({ text: "My sugar was 6.8 mmol, I ate laksa", remoteExtraction });
      await speakAndStop(context);
      fireEvent.click(await screen.findByRole("button", { name: context.pending.remote.offer }));
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.accept }));
      await waitFor(() => expect(remoteExtraction).toHaveBeenCalledTimes(1));
      const signal = remoteExtraction.mock.calls[0]![2];
      context.view.unmount();
      expect(signal.aborted).toBe(true);
      cleanup();
      const saved = setup({ text: "My sugar was 6.8 mmol, I ate laksa", remoteExtraction: vi.fn() });
      await speakAndStop(saved);
      expect(await screen.findByRole("button", { name: saved.pending.remote.offer })).toBeInTheDocument();
      fireEvent.click((await screen.findAllByRole("button", { name: saved.pending.card.save }))[0]!);
      await waitFor(() => expect(saved.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: saved.pending.remote.offer })).toBeNull());
    });
  });

  it("voice off: unavailable with manual entry, and no microphone, credential request or session", async () => {
    const context = setup({ voiceAvailable: false });
    expect(screen.getByText(context.messages.voice.state.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: context.pending.review.backToToday }));
    expect(context.onClose).toHaveBeenCalledTimes(1);
      expect(context.onManualEntry).not.toHaveBeenCalled();
    expect(context.loadTranscriber).not.toHaveBeenCalled();
    expect(context.fake.calls).toEqual([]);
  });

  it("server-side voice off (VOICE_DISABLED) shows unavailable; nothing is simulated", async () => {
    const context = setup({ script: { start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "VOICE_DISABLED" } } });
    fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.accept }));
    expect(await screen.findByText(context.messages.voice.state.unavailable)).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toEqual([]);
  });

  it("declining the disclosure loads nothing and offers manual entry", async () => {
    const context = setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.decline }));
    expect(context.loadTranscriber).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: context.pending.review.backToToday })).toBeInTheDocument();
  });

  it("unmount while listening cancels the session and releases the microphone", async () => {
    const context = setup();
    fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.accept }));
    await waitFor(() => expect(screen.getByRole("button", { name: context.messages.voice.state.stop })).not.toBeDisabled());
    context.view.unmount();
    await waitFor(() => expect(context.fake.calls).toEqual(["start:en", "cancel", "release"]));
  });

  describe("review fixes (screen and wiring review)", () => {
    it("I-5: a probe that says unavailable shows unavailable and manual entry at once: no disclosure, passcode, transcriber or session", async () => {
      for (const checkAvailability of [vi.fn(async () => false), vi.fn(async () => Promise.reject(new Error("TEST-ONLY probe failure")))]) {
        const context = setup({ checkAvailability, text: "My sugar was 6.8 mmol" });
        expect(screen.getByRole("status")).toHaveTextContent(context.pending.state.checking);
        expect(screen.queryByRole("dialog")).toBeNull();
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(context.messages.voice.state.unavailable));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByLabelText(context.messages.aiAccess.passcodeLabel)).toBeNull();
        expect(context.loadTranscriber).not.toHaveBeenCalled();
        expect(context.fake.calls).toEqual([]);
        expect(checkAvailability).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: context.pending.review.backToToday }));
        expect(context.onClose).toHaveBeenCalledTimes(1);
      expect(context.onManualEntry).not.toHaveBeenCalled();
        cleanup();
      }
    });

    it("I-5: an available probe leads to the disclosure; a restart probes again before the next disclosure", async () => {
      const checkAvailability = vi.fn(async () => true);
      const context = setup({ checkAvailability, text: "My sugar was 6.8 mmol" });
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.decline }));
      expect(screen.getByRole("status")).toHaveTextContent(context.pending.state.declined);
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.entry }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(checkAvailability).toHaveBeenCalledTimes(2);
    });

    it("M-5: declining says plainly that voice was not turned on", () => {
      const context = setup();
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.decline }));
      expect(screen.getByRole("status")).toHaveTextContent(context.pending.state.declined);
    });

    it("I-1 / M-11: a save during a pending remote request: the merge is not applied, the saved card stays saved, nothing is saved twice", async () => {
      let resolve: (value: { kind: "CANDIDATES"; candidates: VoiceCandidate[] }) => void = () => undefined;
      const remoteExtraction = vi.fn(() => new Promise<{ kind: "CANDIDATES"; candidates: VoiceCandidate[] }>((done) => (resolve = done)));
      const text = "My sugar was 6.8 mmol, I ate laksa";
      const context = setup({ text, remoteExtraction });
      await speakAndStop(context);
      fireEvent.click(await screen.findByRole("button", { name: context.pending.remote.offer }));
      fireEvent.click(screen.getByRole("button", { name: context.pending.remote.accept }));
      await waitFor(() => expect(remoteExtraction).toHaveBeenCalledTimes(1));
      const glucose = screen.getAllByRole("article")[0]!;
      fireEvent.click(within(glucose).getByRole("button", { name: context.pending.card.save }));
      await waitFor(() => expect(within(glucose).getByText(context.pending.card.saved)).toBeInTheDocument());
      const start = [...text.slice(0, text.indexOf("I ate laksa"))].length;
      await act(async () => {
        resolve({ kind: "CANDIDATES", candidates: [{ kind: "MEAL_NOTE", source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13r.1", span: { start, end: start + 11 }, sourcePhrase: "I ate laksa", slot: "LUNCH", itemText: "laksa", state: "UNDERSTOOD", ambiguity: [] }] });
        await Promise.resolve();
      });
      expect(await screen.findByText(context.pending.remote.keptLocal)).toBeInTheDocument();
      // The same card element is still mounted and still saved; Save cannot run again.
      expect(screen.getAllByRole("article")[0]).toBe(glucose);
      expect(within(glucose).getByText(context.pending.card.saved)).toBeInTheDocument();
      expect(within(glucose).getByRole("button", { name: context.pending.card.save })).toBeDisabled();
      expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
    });

    it("I-2 / M-11: Discard after a save says the saved items stay; Discard without a save says nothing was saved", async () => {
      const context = setup({ text: "My sugar was 6.8 mmol, I ate laksa" });
      await speakAndStop(context);
      const glucose = (await screen.findAllByRole("article"))[0]!;
      fireEvent.click(within(glucose).getByRole("button", { name: context.pending.card.save }));
      await waitFor(() => expect(within(glucose).getByText(context.pending.card.saved)).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
      expect(screen.getByRole("status")).toHaveTextContent(context.pending.state.doneSaved);
      expect(screen.queryByText(context.messages.voice.state.cancelled)).toBeNull();
      cleanup();
      const unsaved = setup({ text: "My sugar was 6.8 mmol" });
      await speakAndStop(unsaved);
      await screen.findAllByRole("article");
      fireEvent.click(screen.getByRole("button", { name: unsaved.messages.voice.review.discard }));
      expect(screen.getByRole("status")).toHaveTextContent(unsaved.messages.voice.state.cancelled);
    });

    it("M-11: Stop releases the microphone before the review", async () => {
      const context = setup({ text: "My sugar was 6.8 mmol" });
      await speakAndStop(context);
      await screen.findAllByRole("article");
      expect(context.fake.calls).toContain("release");
      expect(context.fake.calls.indexOf("release")).toBeGreaterThan(context.fake.calls.indexOf("start:en"));
    });

    // W-6a (deliberate change): the limit now stops like Stop (no TIMED_OUT). Round 4: a 30 s limit is not the 60 s limit, so the plain
    // stop path applies (no "60-second" notice); nothing was captured, so the nothing-understood state.
    it("M-11: the session time limit ends listening, releases the microphone and saves nothing", async () => {
      const pending: Array<{ callback: () => void; ms: number }> = [];
      const timers = { setTimeout: (callback: () => void, ms: number) => (pending.push({ callback, ms }), pending.length), clearTimeout: () => undefined };
      const context = setup({ script: { release: "AUTO" }, timers, maxSessionSeconds: 30 });
      fireEvent.change(screen.getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.disclosure.accept }));
      await waitFor(() => expect(screen.getByRole("button", { name: context.messages.voice.state.stop })).not.toBeDisabled());
      const limit = pending.find((entry) => entry.ms === 30_000);
      expect(limit).toBeDefined();
      await act(async () => {
        limit!.callback();
        await Promise.resolve();
      });
      expect(await screen.findByText(context.messages.voice.review.nothingFound)).toBeInTheDocument();
      expect(screen.queryByText(context.pending.limit.empty)).toBeNull();
      expect(screen.queryByText(context.messages.voice.state.timedOut)).toBeNull();
      await waitFor(() => expect(context.fake.calls).toContain("release"));
      expect(context.fake.calls).toContain("stop");
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it("M-3: the 'nothing was saved' note is not shown beside saveable cards; M-6: the app-default unit label", async () => {
      const mixed = setup({ text: "sugar 15 mmol, how many units now" });
      await speakAndStop(mixed);
      expect(await screen.findByText(mixed.messages.voice.redirect.body)).toBeInTheDocument();
      expect(screen.queryByText(mixed.messages.voice.redirect.transcribedNote)).toBeNull();
      cleanup();
      const defaulted = setup({ text: "Sugar reading 9.2", glucoseEntryUnit: "MMOL_PER_L" });
      await speakAndStop(defaulted);
      expect(await screen.findByText("Unit is the app default (mmol/L)")).toBeInTheDocument();
      expect(VOICE_SCREEN_PENDING_COPY["zh-SG"].card.unitAppDefault).toBe("单位为应用默认值（mmol/L）");
    });

    it("M-7 / M-8: an unsaved amount promises no manual field; a medicine card that needs editing does not show 'Taken'", async () => {
      expect(VOICE_SCREEN_PENDING_COPY["en-SG"].card.amountNotSaved).toBe("This amount will not be saved.");
      const context = setup({ text: "I skipped 10 units of my grey pen", reportedAmountSaved: true });
      await speakAndStop(context);
      const card = (await screen.findAllByRole("article"))[0]!;
      expect(within(card).getByText(context.pending.card.needsEdit)).toBeInTheDocument();
      expect(within(card).queryByText(context.pending.card.statusSkipped)).toBeNull();
      expect(within(card).queryByText(context.pending.card.statusTaken)).toBeNull();
    });
  });

  describe("Words JagaOn remembers (terminology review Critical #1)", () => {
    const openTerms = (heading: string) => {
      const details = screen.getByText(heading).closest("details")!;
      expect(details.open).toBe(false);
      details.open = true;
      fireEvent(details, new Event("toggle"));
      return details;
    };

    it("lists a remembered word; Forget asks first (Keep it is focused), forgets it, records nothing, and the question returns next time", async () => {
      const context = setup({ text: "I injected my grey pen" });
      context.terminology.terms.push({ recordId: "00000000-0000-4000-8000-0000000000a1", revisionId: "00000000-0000-4000-8000-0000000000b1", language: "en", phrase: "grey pen", medication: GREY });
      await speakAndStop(context);
      expect(await screen.findByText("Apidra (demo)")).toBeInTheDocument();
      const details = openTerms(context.pending.terms.heading);
      expect(await within(details).findByText(context.pending.terms.meaning("grey pen", "Apidra (demo)"))).toBeInTheDocument();
      fireEvent.click(within(details).getByRole("button", { name: `${context.pending.terms.forget} “grey pen”` }));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent(context.pending.terms.forgetTitle);
      expect(dialog).toHaveTextContent(context.pending.terms.forgetBody("grey pen"));
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: context.pending.terms.forgetCancel }));
      fireEvent.click(within(dialog).getByRole("button", { name: context.pending.terms.forgetConfirm }));
      expect(await within(details).findByText(context.pending.terms.forgotten)).toBeInTheDocument();
      expect(await within(details).findByText(context.pending.terms.empty)).toBeInTheDocument();
      expect(context.terminology.forget).toHaveBeenCalledWith({ recordId: "00000000-0000-4000-8000-0000000000a1" });
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      // Next session: the word is no longer reused; the question appears again.
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
      fireEvent.click(await screen.findByRole("button", { name: context.messages.voice.entry }));
      await speakAndStop(context);
      expect(await screen.findByRole("button", { name: context.pending.card.chooseMedicine })).toBeInTheDocument();
    });

    it("Change reuses the medicine picker (no 'remember' choice) and the word then resolves to the new medicine", async () => {
      const context = setup({ text: "I injected my grey pen" });
      context.terminology.terms.push({ recordId: "00000000-0000-4000-8000-0000000000a2", revisionId: "00000000-0000-4000-8000-0000000000b2", language: "en", phrase: "grey pen", medication: GREY });
      await speakAndStop(context);
      await screen.findByText("Apidra (demo)");
      const details = openTerms(context.pending.terms.heading);
      fireEvent.click(await within(details).findByRole("button", { name: `${context.pending.terms.change} “grey pen”` }));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent(context.pending.terms.changeTitle("grey pen"));
      fireEvent.click(within(dialog).getByLabelText("Lantus (demo)"));
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: context.pending.card.chooseMedicine }));
      expect(await within(details).findByText(context.pending.terms.changed)).toBeInTheDocument();
      expect(await within(details).findByText(context.pending.terms.meaning("grey pen", "Lantus (demo)"))).toBeInTheDocument();
      expect(context.terminology.change).toHaveBeenCalledWith({ recordId: "00000000-0000-4000-8000-0000000000a2", expectedRevisionId: "00000000-0000-4000-8000-0000000000b2", medication: DARK });
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
      fireEvent.click(await screen.findByRole("button", { name: context.messages.voice.entry }));
      await speakAndStop(context);
      expect(await screen.findByText("Lantus (demo)")).toBeInTheDocument();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
    });

    it("a stale Change is refused and the list reloads; zh: Escape keeps the word", async () => {
      const context = setup({ locale: "zh-SG", text: "我打了灰色的笔" });
      context.terminology.terms.push({ recordId: "00000000-0000-4000-8000-0000000000a3", revisionId: "00000000-0000-4000-8000-0000000000b3", language: "zh", phrase: "灰色的笔", medication: GREY });
      await speakAndStop(context);
      await screen.findByText("Apidra (demo)");
      const details = openTerms(context.pending.terms.heading);
      fireEvent.click(await within(details).findByRole("button", { name: `${context.pending.terms.change} “灰色的笔”` }));
      context.terminology.terms[0]!.revisionId = "00000000-0000-4000-8000-0000000000c3";
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByLabelText("Lantus (demo)"));
      fireEvent.click(within(dialog).getByRole("button", { name: context.pending.card.chooseMedicine }));
      expect(await within(details).findByText(context.pending.terms.stale)).toBeInTheDocument();
      expect(await within(details).findByText(context.pending.terms.meaning("灰色的笔", "Apidra (demo)"))).toBeInTheDocument();
      fireEvent.click(within(details).getByRole("button", { name: `${context.pending.terms.forget} “灰色的笔”` }));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(context.terminology.forget).not.toHaveBeenCalled();
      expect(within(details).getByText(context.pending.terms.meaning("灰色的笔", "Apidra (demo)"))).toBeInTheDocument();
    });

    it("terminology review #2: a medicine phrase with a time or amount word is never offered for remembering", async () => {
      const context = setup({ text: "I injected my night pen" });
      await speakAndStop(context);
      fireEvent.click(await screen.findByRole("button", { name: context.pending.card.chooseMedicine }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByLabelText("Apidra (demo)"));
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
    });
  });
});
