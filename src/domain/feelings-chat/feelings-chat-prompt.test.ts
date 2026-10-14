import { describe, expect, it } from "vitest";
import { NOTE_THEME_KEYS } from "@/domain/notes/note-themes";
import type { FeelingsChatRequest } from "./feelings-chat-contract";
import { FEELINGS_CHAT_FEW_SHOTS, FEELINGS_CHAT_PROMPT_VERSION, FEELINGS_CHAT_SYSTEM_PROMPT, buildFeelingsChatPromptMessages } from "./feelings-chat-prompt";

/** Tell JagaOn understands more (design §3.7): the versioned system prompt and the provider message list. */

const request: FeelingsChatRequest = {
  task: "FEELINGS_CHAT_TURN",
  turn: 2,
  maxTurns: 3,
  messages: [
    { role: "patient", text: "Feeling tired and a bit worried today." },
    { role: "jagaon_question", text: "What has been making you feel tired lately?" },
    { role: "patient", text: "Not getting enough sleep." },
  ],
};

describe("feelings-chat prompt (feelings-chat-prompt.1)", () => {
  it("is versioned and holds the role, hard rules, turn control, strict output, theme list and the safety second net", () => {
    expect(FEELINGS_CHAT_PROMPT_VERSION).toBe("feelings-chat-prompt.1");
    for (const section of ["ROLE", "HARD RULES", "TURN CONTROL", "OUTPUT", "SAFETY", "EXAMPLES"]) expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain(`\n${section}\n`.trimStart());
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("You are a gentle listener inside a diabetes self-care diary.");
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("Never give advice");
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("Never link feelings to blood sugar");
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("On turn 3, or when the person says they are done, return kind WRAP_UP");
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("Return strict JSON only");
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain(JSON.stringify([...NOTE_THEME_KEYS]));
    expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain("self-harm");
  });

  it("has 4–6 few-shot examples, exactly one corrected bad draft, one wrap-up with a doctor question and one safety stop", () => {
    expect(FEELINGS_CHAT_FEW_SHOTS.length).toBeGreaterThanOrEqual(4);
    expect(FEELINGS_CHAT_FEW_SHOTS.length).toBeLessThanOrEqual(6);
    expect(FEELINGS_CHAT_FEW_SHOTS.filter((shot) => shot.badDraft)).toHaveLength(1);
    expect(FEELINGS_CHAT_FEW_SHOTS.some((shot) => shot.reply.kind === "WRAP_UP" && shot.reply.doctorQuestion !== null)).toBe(true);
    expect(FEELINGS_CHAT_FEW_SHOTS.some((shot) => shot.reply.kind === "WRAP_UP" && shot.reply.summary === null && shot.reply.end)).toBe(true);
    for (const shot of FEELINGS_CHAT_FEW_SHOTS) expect(FEELINGS_CHAT_SYSTEM_PROMPT).toContain(JSON.stringify(shot.reply));
  });

  it("builds exactly [system, user]; the user message is exactly {turn, maxTurns, messages}, nothing else", () => {
    const built = buildFeelingsChatPromptMessages(request);
    expect(built.map((message) => message.role)).toEqual(["system", "user"]);
    expect(built[0]!.text).toBe(FEELINGS_CHAT_SYSTEM_PROMPT);
    expect(JSON.parse(built[1]!.text)).toEqual({ turn: 2, maxTurns: 3, messages: request.messages });
    expect(Object.keys(JSON.parse(built[1]!.text))).toEqual(["turn", "maxTurns", "messages"]);
  });

  it("copies only role and text from each message (an extra field on an unchecked object never rides along)", () => {
    const smuggled = { ...request, messages: [{ role: "patient", text: "Tired.", reading: 7.2, name: "Mdm Tan" }] } as unknown as FeelingsChatRequest;
    const user = buildFeelingsChatPromptMessages(smuggled)[1]!.text;
    expect(JSON.parse(user).messages).toEqual([{ role: "patient", text: "Tired." }]);
    expect(user).not.toMatch(/reading|Mdm Tan|task/);
  });
});
