// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceFactDecision } from "@/application/voice/voice-review-contract";
import { analyseTranscript } from "@/domain/voice/voice-candidate-extractor";
import type { VoiceActivityCandidate, VoiceFeelingCandidate } from "@/domain/voice/voice-contracts";
import { getMessages } from "@/i18n/get-messages";
import { VoiceActivityCard } from "./VoiceActivityCard";
import type { VoiceFactOutcome } from "./VoiceFactCard";
import { VoiceFeelingCard } from "./VoiceFeelingCard";
import { voiceScreenCopy } from "./voice-screen-copy";

/** Owner decision 2026-10-14 (Tell JagaOn understands more): the Feeling and Activity cards. Synthetic text only. */
afterEach(cleanup);
const copy = voiceScreenCopy(getMessages("en-SG"), "en-SG");
const candidate = <K extends "FEELING_NOTE" | "ACTIVITY_NOTE">(text: string, kind: K) => {
  const result = analyseTranscript(text, "en");
  const found = result.candidates.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no ${kind} in ${text}`);
  return found as K extends "FEELING_NOTE" ? VoiceFeelingCandidate : VoiceActivityCandidate;
};
const decider = (outcome: VoiceFactOutcome = "SAVED") => vi.fn(async (decision: VoiceFactDecision) => (void decision, outcome));

describe("Feeling card", () => {
  const feeling = candidate("Feeling tired and a bit worried today.", "FEELING_NOTE");

  it("shows her words (editable), Save as a note and Skip; no Talk it through without the port", () => {
    render(<VoiceFeelingCard candidate={feeling} index={0} copy={copy} onDecide={decider()} />);
    const card = screen.getByRole("article", { name: "Feeling" });
    expect(within(card).getByLabelText(copy.feeling.textLabel)).toHaveValue("Feeling tired and a bit worried today.");
    expect(within(card).getByRole("button", { name: "Save as a note" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Skip" })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: "Talk it through" })).toBeNull();
  });

  it("Save as a note sends a SAVE decision (no edit when unchanged), then shows the reviewed kind sentence calmly", async () => {
    const onDecide = decider();
    render(<VoiceFeelingCard candidate={feeling} index={2} copy={copy} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as a note" }));
    await waitFor(() => expect(screen.getByText("That sounds like a tiring day. Thank you for telling me.")).toBeInTheDocument());
    expect(onDecide).toHaveBeenCalledWith({ candidateIndex: 2, action: "SAVE" });
    expect(screen.getByText(copy.feeling.savedToNotes)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as a note" })).toBeNull();
    expect(screen.getByLabelText(copy.feeling.textLabel)).toBeDisabled();
  });

  it("an edit travels as the person's words, trimmed; empty words cannot be saved", async () => {
    const onDecide = decider();
    render(<VoiceFeelingCard candidate={feeling} index={0} copy={copy} onDecide={onDecide} />);
    const field = screen.getByLabelText(copy.feeling.textLabel);
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save as a note" })).toBeDisabled();
    expect(screen.getByText(copy.feeling.textRequired)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "  Tired, slept badly.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a note" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({ candidateIndex: 0, action: "SAVE", edit: { kind: "FEELING_NOTE", text: "Tired, slept badly." } }));
  });

  it("Skip saves nothing; a failed save says so", async () => {
    const onDecide = decider("NOT_SAVED");
    const { unmount } = render(<VoiceFeelingCard candidate={feeling} index={0} copy={copy} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as a note" }));
    await waitFor(() => expect(screen.getByText(copy.feeling.notSaved)).toBeInTheDocument());
    expect(screen.queryByText(/Thank you/)).toBeNull();
    unmount();
    const skipDecide = decider();
    render(<VoiceFeelingCard candidate={feeling} index={0} copy={copy} onDecide={skipDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText(copy.feeling.skipped)).toBeInTheDocument();
    expect(skipDecide).not.toHaveBeenCalled();
  });

  it("Talk it through appears only with the port and hands over her (edited) words and the cue keys; nothing is saved", () => {
    const onDecide = decider();
    const onTalkItThrough = vi.fn();
    render(<VoiceFeelingCard candidate={feeling} index={0} copy={copy} onDecide={onDecide} onTalkItThrough={onTalkItThrough} />);
    fireEvent.change(screen.getByLabelText(copy.feeling.textLabel), { target: { value: "Tired and worried. " } });
    fireEvent.click(screen.getByRole("button", { name: "Talk it through" }));
    expect(onTalkItThrough).toHaveBeenCalledWith({ text: "Tired and worried.", cueKeys: ["tired", "worried"] });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("Activity card", () => {
  const activity = candidate("Walked 30 minutes after dinner", "ACTIVITY_NOTE");

  it("shows the summary (category · minutes · time phrase) and her words, editable", () => {
    render(<VoiceActivityCard candidate={activity} index={0} copy={copy} onDecide={decider()} />);
    const card = screen.getByRole("article", { name: "Activity" });
    expect(within(card).getByText("Walk · 30 min · after dinner")).toBeInTheDocument();
    expect(within(card).getByLabelText(copy.activity.labelLabel)).toHaveValue("Walked 30 minutes after dinner");
    expect(within(card).getByLabelText(copy.activity.durationLabel)).toHaveValue("30");
    expect(within(card).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Skip" })).toBeEnabled();
  });

  it("Save sends the proposal unchanged, or the edited label and minutes; empty minutes mean no duration", async () => {
    const onDecide = decider();
    const { unmount } = render(<VoiceActivityCard candidate={activity} index={1} copy={copy} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(copy.activity.saved)).toBeInTheDocument());
    expect(onDecide).toHaveBeenCalledWith({ candidateIndex: 1, action: "SAVE" });
    unmount();
    const edited = decider();
    render(<VoiceActivityCard candidate={activity} index={1} copy={copy} onDecide={edited} />);
    fireEvent.change(screen.getByLabelText(copy.activity.labelLabel), { target: { value: "Evening walk " } });
    fireEvent.change(screen.getByLabelText(copy.activity.durationLabel), { target: { value: "" } });
    expect(screen.getByText(`Walk · ${copy.activity.noDuration}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(edited).toHaveBeenCalledWith({ candidateIndex: 1, action: "SAVE", edit: { kind: "ACTIVITY_NOTE", label: "Evening walk", durationMinutes: null } }));
  });

  it("refuses minutes that are not whole minutes from 1 to 1440, and an empty label", () => {
    render(<VoiceActivityCard candidate={activity} index={0} copy={copy} onDecide={decider()} />);
    const minutes = screen.getByLabelText(copy.activity.durationLabel);
    for (const value of ["0", "1441", "2.5", "abc", "-5"]) {
      fireEvent.change(minutes, { target: { value } });
      expect(screen.getByRole("button", { name: "Save" }), value).toBeDisabled();
      expect(screen.getByText(copy.activity.durationInvalid)).toBeInTheDocument();
    }
    fireEvent.change(minutes, { target: { value: "45" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(copy.activity.labelLabel), { target: { value: " " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Skip saves nothing", () => {
    const onDecide = decider();
    render(<VoiceActivityCard candidate={activity} index={0} copy={copy} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText(copy.activity.skipped)).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });
});
