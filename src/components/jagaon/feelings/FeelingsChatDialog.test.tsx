import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeFeelingsChatPort, type FakeFeelingsChatStep } from "@/application/feelings-chat/feelings-chat-fake-port";
import { FALLBACK_QUESTIONS, KIND_SENTENCES } from "@/domain/feelings-chat/feelings-chat-bank";
import { getMessages } from "@/i18n/get-messages";
import { FeelingsChatDialog, type FeelingsChatNote } from "./FeelingsChatDialog";

/**
 * Tell JagaOn understands more (design §3.1): the feelings chat dialog with the pure fake port (no network, no live call), a fake
 * distress gate and spy callbacks. Synthetic text only.
 */
afterEach(() => cleanup());

const messages = getMessages("en-SG");
const t = messages.feelingsChat;
const FIRST = "Feeling tired and a bit worried today.";
const Q1 = "What has been making you feel tired lately?";
const Q2 = "What has been keeping you up at night?";
const A1 = "Not getting enough sleep, only 4 hours a night.";
const A2 = "Thinking about my son and his job.";
const ask = (question: string) => ({ candidate: { kind: "QUESTION", question, summary: null, doctorQuestion: null, themes: [], end: false } });
const WRAP = {
  candidate: {
    kind: "WRAP_UP",
    question: null,
    summary: "Feeling tired; sleeping about 4 hours a night because of worry about family.",
    doctorQuestion: "I've only been sleeping about 4 hours a night. Could this affect my diabetes?",
    themes: ["SLEEP", "FAMILY"],
    end: true,
  },
};

function setup(script: FakeFeelingsChatStep[], overrides: { cueKeys?: string[]; save?: boolean; add?: boolean } = {}) {
  const port = createFakeFeelingsChatPort(script);
  const onSave = vi.fn(async (_note: FeelingsChatNote) => overrides.save ?? true);
  const onAddDoctorQuestion = vi.fn(async (_text: string) => overrides.add ?? true);
  const onDistress = vi.fn();
  const onClose = vi.fn();
  const detectDistress = vi.fn((text: string) => /end it all|don't want to live/i.test(text));
  render(
    <FeelingsChatDialog
      messages={messages}
      initialText={FIRST}
      cueKeys={overrides.cueKeys ?? ["tired", "worried"]}
      chat={port}
      detectDistress={detectDistress}
      onDistress={onDistress}
      onSave={onSave}
      onAddDoctorQuestion={onAddDoctorQuestion}
      onClose={onClose}
    />,
  );
  return { port, onSave, onAddDoctorQuestion, onDistress, onClose, detectDistress };
}

const button = (name: string) => screen.getByRole("button", { name });
const answerBox = () => screen.getByRole("textbox", { name: t.answerLabel });
async function answer(text: string) {
  fireEvent.change(answerBox(), { target: { value: text } });
  fireEvent.click(button(t.send));
}

describe("FeelingsChatDialog", () => {
  it("opens on the owner-approved AI notice with Continue and Save as a note without AI; nothing is sent yet", () => {
    const { port } = setup([]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Talk it through");
    expect(dialog).toHaveAccessibleDescription(
      "To ask you follow-up questions, JagaOn sends what you write in this chat to an AI service. It does not send your readings, medicines or name. Do not enter real patient information in this hackathon demo.",
    );
    expect(screen.getAllByRole("button").map((element) => element.textContent)).toEqual(["Continue", "Save as a note without AI"]);
    expect(document.activeElement).toBe(button("Continue"));
    expect(port.requests()).toHaveLength(0);
  });

  it("Continue: the reviewed kind sentence, then the AI question; focus in the answer box; the question is announced", async () => {
    const { port } = setup([ask(Q1)]);
    fireEvent.click(button(t.continue));
    expect(screen.getByText(KIND_SENTENCES.TIRED)).toBeInTheDocument();
    expect(await screen.findByText(Q1)).toBeInTheDocument();
    expect(document.activeElement).toBe(answerBox());
    expect(screen.getByText(`JagaOn asks: ${Q1}`)).toBeInTheDocument();
    expect(port.requests()).toEqual([{ task: "FEELINGS_CHAT_TURN", turn: 1, maxTurns: 3, messages: [{ role: "patient", text: FIRST }] }]);
    expect(screen.queryByText(t.fallbackNotice)).toBeNull();
  });

  it("an answer moves to the next turn with the chat so far; three turns end in the wrap-up; edits, the doctor question and the saved payload are exact", async () => {
    const { port, onSave, onAddDoctorQuestion, onClose } = setup([ask(Q1), ask(Q2), WRAP]);
    fireEvent.click(button(t.continue));
    await screen.findByText(Q1);
    await answer(A1);
    expect(await screen.findByText(Q2)).toBeInTheDocument();
    await answer(A2);
    const summary = await screen.findByRole("textbox", { name: t.summaryLabel });
    expect(document.activeElement).toBe(summary);
    expect(port.requests().map((request) => request.turn)).toEqual([1, 2, 3]);
    expect(port.requests()[2]!.messages).toEqual([
      { role: "patient", text: FIRST },
      { role: "jagaon_question", text: Q1 },
      { role: "patient", text: A1 },
      { role: "jagaon_question", text: Q2 },
      { role: "patient", text: A2 },
    ]);
    expect(summary).toHaveValue(WRAP.candidate.summary);
    fireEvent.change(summary, { target: { value: "Feeling tired; worried about my son." } });
    const doctor = screen.getByRole("textbox", { name: t.doctorQuestionTitle });
    expect(doctor).toHaveValue(WRAP.candidate.doctorQuestion);
    fireEvent.change(doctor, { target: { value: "I only sleep 4 hours a night. Could this affect my diabetes?" } });
    fireEvent.click(button(t.addToQuestions));
    expect(await screen.findByText(t.questionAdded, { selector: "[role=status]" })).toBeInTheDocument();
    expect(onAddDoctorQuestion).toHaveBeenCalledWith("I only sleep 4 hours a night. Could this affect my diabetes?");
    fireEvent.click(button(t.saveNote));
    await screen.findByText(t.saved, { selector: "[role=status]" });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({
      text: "Feeling tired; worried about my son.",
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
    });
    expect(document.activeElement).toBe(button(t.done));
    fireEvent.click(button(t.done));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a distress answer calls onDistress and closes without saving or sending", async () => {
    const { port, onSave, onDistress, onClose } = setup([ask(Q1), ask(Q2)]);
    fireEvent.click(button(t.continue));
    await screen.findByText(Q1);
    await answer("I just want to end it all.");
    expect(onDistress).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(port.requests()).toHaveLength(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the AI's own safety stop (the second net) also calls onDistress and saves nothing", async () => {
    const { onDistress, onSave } = setup([{ candidate: { kind: "WRAP_UP", question: null, summary: null, doctorQuestion: null, themes: [], end: true } }]);
    fireEvent.click(button(t.continue));
    await waitFor(() => expect(onDistress).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("No, thanks hides the doctor question and nothing is added", async () => {
    const { onAddDoctorQuestion } = setup([ask(Q1), ask(Q2), WRAP]);
    fireEvent.click(button(t.continue));
    await screen.findByText(Q1);
    await answer(A1);
    await screen.findByText(Q2);
    await answer(A2);
    await screen.findByRole("textbox", { name: t.summaryLabel });
    fireEvent.click(button(t.noThanks));
    expect(screen.queryByRole("textbox", { name: t.doctorQuestionTitle })).toBeNull();
    expect(onAddDoctorQuestion).not.toHaveBeenCalled();
  });

  it("Save as a note without AI saves at once: her words and the kind sentence, aiUsed false; nothing is sent", async () => {
    const { port, onSave } = setup([ask(Q1)], { cueKeys: ["sad"] });
    fireEvent.click(button(t.saveWithoutAi));
    await screen.findByText(t.saved, { selector: "[role=status]" });
    expect(port.requests()).toHaveLength(0);
    expect(onSave.mock.calls[0]![0]).toEqual({
      text: FIRST,
      feelingCues: ["sad"],
      turns: [
        { role: "PATIENT", text: FIRST, source: "PATIENT" },
        { role: "JAGAON_KIND_SENTENCE", text: KIND_SENTENCES.SAD_OR_LOW, source: "REVIEWED_BANK" },
      ],
      themes: [],
      aiUsed: false,
      promptVersion: null,
    });
  });

  it("when the AI is unavailable or rejected, the bank's questions are shown with the standard-questions notice; the wrap-up offers the bank's turn-3 question for her own doctor question", async () => {
    const { onSave } = setup([{ unavailable: "OFFLINE" }, ask("Why don't you rest more?"), { unavailable: "UPSTREAM_ERROR" }]);
    fireEvent.click(button(t.continue));
    expect(await screen.findByText(FALLBACK_QUESTIONS[0]!)).toBeInTheDocument();
    expect(screen.getByText(t.fallbackNotice)).toBeInTheDocument();
    await answer(A1);
    expect(await screen.findByText(FALLBACK_QUESTIONS[1]!)).toBeInTheDocument();
    expect(screen.queryByText("Why don't you rest more?")).toBeNull();
    await answer(A2);
    const summary = await screen.findByRole("textbox", { name: t.summaryLabel });
    expect(summary).toHaveValue(FIRST);
    const doctor = screen.getByRole("textbox", { name: FALLBACK_QUESTIONS[2]! });
    expect(doctor).toHaveValue("");
    expect(button(t.addToQuestions)).toBeDisabled();
    fireEvent.click(button(t.saveNote));
    await screen.findByText(t.saved, { selector: "[role=status]" });
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      text: FIRST,
      themes: [],
      aiUsed: false,
      promptVersion: null,
      turns: [
        { role: "PATIENT", text: FIRST, source: "PATIENT" },
        { role: "JAGAON_KIND_SENTENCE", text: KIND_SENTENCES.TIRED, source: "REVIEWED_BANK" },
        { role: "JAGAON_QUESTION", text: FALLBACK_QUESTIONS[0], source: "REVIEWED_BANK" },
        { role: "PATIENT", text: A1, source: "PATIENT" },
        { role: "JAGAON_QUESTION", text: FALLBACK_QUESTIONS[1], source: "REVIEWED_BANK" },
        { role: "PATIENT", text: A2, source: "PATIENT" },
      ],
    });
  });

  it("an AI credit limit shows the credit wording instead of the plain notice", async () => {
    setup([{ unavailable: "SPEND_CEILING_REACHED" }]);
    fireEvent.click(button(t.continue));
    expect(await screen.findByText(t.creditLimitNotice)).toBeInTheDocument();
  });

  it("Skip asks the next turn without sending the skipped question; End chat asks for the wrap-up at once", async () => {
    const { port } = setup([ask(Q1), ask(Q2), WRAP]);
    fireEvent.click(button(t.continue));
    await screen.findByText(Q1);
    fireEvent.click(button(t.skip));
    await screen.findByText(Q2);
    expect(port.requests()[1]).toEqual({ task: "FEELINGS_CHAT_TURN", turn: 2, maxTurns: 3, messages: [{ role: "patient", text: FIRST }] });
    fireEvent.change(answerBox(), { target: { value: A2 } });
    fireEvent.click(button(t.endChat));
    await screen.findByRole("textbox", { name: t.summaryLabel });
    expect(port.requests()[2]).toEqual({ task: "FEELINGS_CHAT_TURN", turn: 3, maxTurns: 3, messages: [{ role: "patient", text: FIRST }, { role: "jagaon_question", text: Q2 }, { role: "patient", text: A2 }] });
  });

  it("a failed save says so and keeps the note; Escape closes without saving", async () => {
    const { onClose } = setup([], { save: false });
    fireEvent.click(button(t.saveWithoutAi));
    expect(await screen.findByRole("alert")).toHaveTextContent(t.saveFailed);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("every row comes from the feelingsChat catalogue in both locales (zh-SG: drafts)", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const block = getMessages(locale).feelingsChat;
      for (const [key, value] of Object.entries(block)) {
        if (typeof value === "function") expect(value("x").length, `${locale}.${key}`).toBeGreaterThan(1);
        else expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
