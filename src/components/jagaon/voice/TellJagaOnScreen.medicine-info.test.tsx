// @vitest-environment jsdom
// HSA preview (owner decision 2026-10-14, "Tell me about my medicine"): the medicine information card in the Tell JagaOn review area.
// A fake transcriber and a fake route fetcher (no network, no live call). Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMedicineInfoClient } from "@/application/medicine-info/medicine-info-client";
import { createFakeVoiceTranscriber } from "@/application/voice/fake-voice-transcriber";
import type { VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import type { VoiceMedicationRef } from "@/domain/voice/voice-contracts";
import { MEDICINE_INFO_DIRECTIONS_SENTENCE } from "@/domain/medicine-info/medicine-info-validator";
import { getMessages } from "@/i18n/get-messages";
import { HSA_BOUNDED_MODE_STORAGE_KEY, HsaBoundedModeProvider, resetHsaBoundedModeForTests } from "../hsa/hsa-bounded-mode";
import { MedicineInfoClientProvider } from "../medicine-info/MedicineGeneralInfoPreview";
import { TellJagaOnScreen, type VoiceRemoteExtraction, type VoiceTerminologyPort } from "./TellJagaOnScreen";
import { VOICE_SCREEN_PENDING_COPY } from "./voice-screen-copy";

const en = getMessages("en-SG");
const t = en.hsaMedicineInfo;
const PASSCODE = "TEST-ONLY-voice-passcode";
const MED: VoiceMedicationRef = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" };
const USED_FOR = "Metformin is a medicine used to help control blood sugar in people with type 2 diabetes.";
const HOW_TAKEN = `It is generally taken by mouth with or after meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const terminology: VoiceTerminologyPort = {
  directory: async () => ({ terms: [], names: [{ name: "Metformin", medication: MED }] }),
  activeMedicines: async () => [{ medication: MED, names: ["Metformin"] }],
  remember: async () => ({ kind: "COMMITTED" }),
};

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

function setup(options: { text: string; bounded: boolean; remoteExtraction?: VoiceRemoteExtraction }) {
  if (!options.bounded) store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
  const bodies: unknown[] = [];
  const client = createMedicineInfoClient({
    fetcher: async (_input, init) => (bodies.push(JSON.parse(String(init.body))), json({ kind: "OK", info: { name: "Metformin", genericName: null, usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN } })),
  });
  const onSaveFacts = vi.fn(async (intent: VoiceSaveIntent) => (void intent, { kind: "SAVED" as const }));
  const onOpenMyMedicines = vi.fn();
  render(
    <HsaBoundedModeProvider>
      <MedicineInfoClientProvider client={client}>
        <TellJagaOnScreen
          messages={en}
          locale="en-SG"
          loadTranscriber={async () => createFakeVoiceTranscriber({ segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: options.text }] })}
          terminology={terminology}
          glucoseEntryUnit="MMOL_PER_L"
          onSaveFacts={onSaveFacts}
          onManualEntry={vi.fn()}
          onClose={vi.fn()}
          onOpenMyMedicines={onOpenMyMedicines}
          remoteExtraction={options.remoteExtraction}
        />
      </MedicineInfoClientProvider>
    </HsaBoundedModeProvider>,
  );
  return { bodies, onSaveFacts, onOpenMyMedicines };
}

async function speakAndStop() {
  fireEvent.change(screen.getByLabelText(en.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
  fireEvent.click(screen.getByRole("button", { name: en.voice.disclosure.accept }));
  await waitFor(() => expect(screen.getByRole("button", { name: en.voice.state.stop })).not.toBeDisabled());
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: en.voice.state.stop }));
}

const cardName = (name: string) => `${en.voice.medicineInfo.heading}: ${name}`;

describe("Tell JagaOn: medicine information card (HSA preview)", () => {
  it("bounded mode OFF: 'Tell me about my Metformin' shows the card with the AI flow and 'Open in My medicines'; nothing is saved", async () => {
    const remoteExtraction = vi.fn<VoiceRemoteExtraction>(async () => ({ kind: "UNAVAILABLE" as const }));
    const context = setup({ text: "Tell me about my Metformin", bounded: false, remoteExtraction });
    await speakAndStop();
    const card = await screen.findByRole("article", { name: cardName("Metformin") });
    expect(card).toHaveTextContent(en.hsa.previewTag);
    expect(within(card).queryByRole("button", { name: VOICE_SCREEN_PENDING_COPY["en-SG"].card.save })).toBeNull();
    expect(screen.queryByText(VOICE_SCREEN_PENDING_COPY["en-SG"].review.notUnderstoodHeading)).toBeNull();
    // Never offered to remote extraction.
    expect(screen.queryByRole("button", { name: VOICE_SCREEN_PENDING_COPY["en-SG"].remote.offer })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: t.getButton }));
    fireEvent.click(within(screen.getByRole("dialog", { name: t.noticeTitle })).getByRole("button", { name: t.noticeContinue }));
    expect(await within(card).findByText(USED_FOR)).toBeInTheDocument();
    expect(context.bodies).toEqual([{ task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin" }]);

    fireEvent.click(within(card).getByRole("button", { name: en.voice.medicineInfo.openInMyMedicines }));
    expect(context.onOpenMyMedicines).toHaveBeenCalledTimes(1);
    expect(context.onSaveFacts).not.toHaveBeenCalled();
    expect(remoteExtraction).not.toHaveBeenCalled();
  });

  it("bounded mode OFF: 'Tell me about Lantus' shows the reviewed HealthHub information, with no AI button", async () => {
    const context = setup({ text: "Tell me about Lantus", bounded: false });
    await speakAndStop();
    const card = await screen.findByRole("article", { name: cardName("Lantus") });
    expect(card).toHaveTextContent(en.medication.glarginePurpose);
    expect(within(card).getByRole("link", { name: `${en.shared.source}: HealthHub` })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: t.getButton })).toBeNull();
    expect(context.bodies).toHaveLength(0);
  });

  it("bounded mode ON: today's behaviour, the sentence is listed as not understood and no card is shown", async () => {
    const context = setup({ text: "What is metformin?", bounded: true });
    await speakAndStop();
    expect(await screen.findByText(VOICE_SCREEN_PENDING_COPY["en-SG"].review.notUnderstoodHeading)).toBeInTheDocument();
    expect(screen.getByText("“What is metformin”")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: cardName("metformin") })).toBeNull();
    expect(screen.queryByRole("button", { name: t.getButton })).toBeNull();
    expect(context.bodies).toHaveLength(0);
  });

  it("a dose question stays the redirect, with no card", async () => {
    setup({ text: "How much metformin should I take?", bounded: false });
    await speakAndStop();
    expect((await screen.findAllByText(en.voice.redirect.body)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("distress still comes first: only the safety message", async () => {
    setup({ text: "Tell me about my Metformin. I want to die.", bounded: false });
    await speakAndStop();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText("Tell me about my Metformin. I want to die.")).toBeNull();
  });
});
