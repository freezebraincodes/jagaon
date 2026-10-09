// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { voiceScreenCopy, type VoiceScreenCopy } from "./voice-screen-copy";

/** Every string the Tell JagaOn screen can render, functions called with sample arguments. */
function rendered(copy: VoiceScreenCopy): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") out.push(String((value as (...args: string[]) => unknown)("dark pen", "Nocturin pen (demo)")));
    else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
  };
  visit(copy);
  return out;
}

describe("voice-copy.13s.2 (screen-local; human acceptance pending)", () => {
  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`${locale}: no rendered string is a placeholder or empty`, () => {
      const strings = rendered(voiceScreenCopy(getMessages(locale), locale));
      expect(strings.length).toBeGreaterThan(40);
      for (const text of strings) {
        expect(text, text).not.toMatch(/PENDING|TODO|TBD|lorem/i);
        expect(text.trim().length, text).toBeGreaterThan(0);
      }
    });
  }

  it("uses the coordinator's exact remote-extraction disclosure wording", () => {
    expect(voiceScreenCopy(getMessages("en-SG"), "en-SG").remote.disclosure).toBe(
      "If you choose this, the text of what you said (not the recording) is sent to DeepSeek, an AI service, to suggest what to fill in. JagaOn does not keep the text. You still check and confirm each item; nothing is saved automatically.",
    );
    expect(voiceScreenCopy(getMessages("zh-SG"), "zh-SG").remote.disclosure).toBe(
      "如果您选择这一项，您说的话的文字（不是录音）会发送给 AI 服务 DeepSeek，用来建议要填写的内容。JagaOn 不保存这些文字。每一项仍由您检查和确认，不会自动保存。",
    );
  });
});
