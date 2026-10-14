import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeFeelingsChatPort, type FakeFeelingsChatStep } from "@/application/feelings-chat/feelings-chat-fake-port";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import type { VoiceProviderResolution } from "@/application/voice/voice-provider-selection";
import { getMessages } from "@/i18n/get-messages";
import { voiceScreenCopy } from "../voice/voice-screen-copy";
import { FeelingsChatDialog } from "./FeelingsChatDialog";
import type { FeelingsChatVoice } from "./FeelingsChatVoiceAnswer";

/**
 * Owner decision 2026-10-14: "Speak my answer" in the feelings chat. A scripted fake transcriber (no microphone, no network, no live
 * call) and the pure fake chat port. Synthetic text only.
 */
afterEach(() => cleanup());

const messages = getMessages("en-SG");
const t = messages.feelingsChat;
const copy = voiceScreenCopy(messages, "en-SG");
const FIRST = "I feel very sad";
const Q1 = "What has been making you feel very sad?";
const Q2 = "What has helped a little?";
const SPOKEN = "My sister moved overseas last month";
const ask = (question: string) => ({ candidate: { kind: "QUESTION", question, summary: null, doctorQuestion: null, themes: [], end: false } });

type Setup = Readonly<{
  script?: FakeVoiceTranscriberScript;
  resolution?: VoiceProviderResolution;
  steps?: FakeFeelingsChatStep[];
  noVoice?: boolean;
}>;

function setup(options: Setup = {}) {
  const port = createFakeFeelingsChatPort(options.steps ?? [ask(Q1), ask(Q2)]);
  const transcribers: ReturnType<typeof createFakeVoiceTranscriber>[] = [];
  const loadTranscriber = vi.fn(async () => {
    const fake = createFakeVoiceTranscriber(options.script ?? { segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: SPOKEN }] });
    transcribers.push(fake);
    return fake;
  });
  const onSessionActivity = vi.fn();
  const voice: FeelingsChatVoice = {
    copy,
    language: "en",
    resolveProvider: async () => options.resolution ?? { kind: "AVAILABLE", provider: "WEB_SPEECH", passcodeRequired: false },
    loadTranscriber,
    onSessionActivity,
  };
  const onDistress = vi.fn();
  const onSave = vi.fn(async () => true);
  render(
    <FeelingsChatDialog
      messages={messages}
      initialText={FIRST}
      cueKeys={["sad"]}
      chat={port}
      detectDistress={(text) => /end it all|don't want to live/i.test(text)}
      onDistress={onDistress}
      onSave={onSave}
      onAddDoctorQuestion={async () => true}
      onClose={vi.fn()}
      {...(options.noVoice ? {} : { voice })}
    />,
  );
  return { port, loadTranscriber, transcribers, onDistress, onSave, onSessionActivity };
}

const button = (name: string) => screen.getByRole("button", { name });
const answerBox = () => screen.getByRole("textbox", { name: t.answerLabel });

async function openChat() {
  fireEvent.click(button(t.continue));
  await screen.findByText(Q1);
}

/** Speak my answer → accept the notice → listening → Stop. */
async function speakAndStop() {
  fireEvent.click(button(t.speakAnswer));
  const accept = await screen.findByRole("button", { name: copy.disclosure.accept });
  fireEvent.click(accept);
  const stop = await screen.findByRole("button", { name: copy.state.stop });
  await waitFor(() => expect(stop).toBeEnabled());
  await act(async () => {
    fireEvent.click(stop);
  });
}

describe("Feelings chat: Speak my answer", () => {
  it("is not offered without a voice setup (typing only, as before)", async () => {
    setup({ noVoice: true });
    await openChat();
    expect(screen.queryByRole("button", { name: t.speakAnswer })).toBeNull();
  });

  it("shows the Web Speech notice first; after Stop her words are in the answer box for her to check; nothing is sent until Send", async () => {
    const { port, loadTranscriber } = setup();
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    expect(await screen.findByRole("heading", { name: copy.webSpeech.consentTitle })).toBeInTheDocument();
    // Nothing is loaded before the notice is accepted, and Send, Skip and End chat wait meanwhile.
    expect(loadTranscriber).not.toHaveBeenCalled();
    expect(button(t.skip)).toBeDisabled();
    fireEvent.click(button(copy.disclosure.accept));
    const stop = await screen.findByRole("button", { name: copy.state.stop });
    await waitFor(() => expect(stop).toBeEnabled());
    expect(screen.getByText(SPOKEN)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(answerBox()).toHaveValue(SPOKEN));
    expect(screen.getByText(t.voiceAdded)).toBeInTheDocument();
    expect(port.requests()).toHaveLength(1);
    expect(button(t.send)).toBeEnabled();
    fireEvent.click(button(t.send));
    await screen.findByText(Q2);
    expect(port.requests()[1]!.messages.at(-1)).toEqual({ role: "patient", text: SPOKEN });
  });

  it("adds spoken words after what she already typed", async () => {
    setup();
    await openChat();
    fireEvent.change(answerBox(), { target: { value: "Lonely." } });
    await speakAndStop();
    await waitFor(() => expect(answerBox()).toHaveValue(`Lonely. ${SPOKEN}`));
  });

  it("asks again before every recording (one notice, one start)", async () => {
    const { loadTranscriber } = setup();
    await openChat();
    await speakAndStop();
    await waitFor(() => expect(answerBox()).toHaveValue(SPOKEN));
    fireEvent.click(button(t.speakAnswer));
    expect(await screen.findByRole("button", { name: copy.disclosure.accept })).toBeInTheDocument();
    expect(loadTranscriber).toHaveBeenCalledTimes(1);
  });

  it("spoken distress goes straight to the helplines: the chat stops and nothing is put in the box or sent", async () => {
    const { onDistress, port, onSave } = setup({ script: { segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "I just want to end it all" }] } });
    await openChat();
    await speakAndStop();
    await waitFor(() => expect(onDistress).toHaveBeenCalledTimes(1));
    expect(port.requests()).toHaveLength(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("No thanks on the notice: no transcriber, back to the button", async () => {
    const { loadTranscriber } = setup();
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    fireEvent.click(await screen.findByRole("button", { name: copy.disclosure.decline }));
    expect(await screen.findByRole("button", { name: t.speakAnswer })).toBeEnabled();
    expect(loadTranscriber).not.toHaveBeenCalled();
    await waitFor(() => expect(button(t.skip)).toBeEnabled());
  });

  it("voice unavailable: says so and keeps typing", async () => {
    const { loadTranscriber } = setup({ resolution: { kind: "UNAVAILABLE" } });
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    expect(await screen.findByText(t.voiceUnavailable)).toBeInTheDocument();
    expect(loadTranscriber).not.toHaveBeenCalled();
    await waitFor(() => expect(answerBox()).not.toHaveAttribute("readonly"));
  });

  it("nothing heard: says so and leaves the box as it was", async () => {
    setup({ script: { segmentsOnStart: [] } });
    await openChat();
    await speakAndStop();
    expect(await screen.findByText(t.voiceNothingHeard)).toBeInTheDocument();
    expect(answerBox()).toHaveValue("");
  });

  it("the microphone is refused: says so", async () => {
    setup({ script: { start: { kind: "FAILED", reason: "PERMISSION_DENIED" } } });
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    fireEvent.click(await screen.findByRole("button", { name: copy.disclosure.accept }));
    expect(await screen.findByText(t.voiceNotAllowed)).toBeInTheDocument();
  });

  it("Cancel while listening drops the words", async () => {
    setup();
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    fireEvent.click(await screen.findByRole("button", { name: copy.disclosure.accept }));
    const listening = await screen.findByRole("region", { name: t.speakAnswer });
    await waitFor(() => expect(within(listening).getByRole("button", { name: copy.state.stop })).toBeEnabled());
    await act(async () => {
      fireEvent.click(within(listening).getByRole("button", { name: copy.state.cancel }));
    });
    expect(await screen.findByRole("button", { name: t.speakAnswer })).toBeInTheDocument();
    expect(answerBox()).toHaveValue("");
  });

  it("asks for the demo passcode when the deployment needs one", async () => {
    const { loadTranscriber } = setup({ resolution: { kind: "AVAILABLE", provider: "TRTC" } });
    await openChat();
    fireEvent.click(button(t.speakAnswer));
    const accept = await screen.findByRole("button", { name: copy.disclosure.accept });
    expect(accept).toBeDisabled();
    fireEvent.change(screen.getByLabelText(copy.passcodeLabel), { target: { value: "TEST-ONLY-passcode" } });
    fireEvent.click(accept);
    await waitFor(() => expect(loadTranscriber).toHaveBeenCalledWith(expect.any(Function), "TRTC", { passcodeRequired: true }));
    expect((loadTranscriber.mock.calls[0] as unknown as [() => string | null])[0]()).toBe("TEST-ONLY-passcode");
  });
});
