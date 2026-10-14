import { describe, expect, it } from "vitest";
import { MEDICINE_INFO_FEW_SHOTS, MEDICINE_INFO_PROMPT_VERSION, MEDICINE_INFO_SYSTEM_PROMPT, buildMedicineInfoPromptMessages } from "./medicine-info-prompt";
import { MEDICINE_INFO_DIRECTIONS_SENTENCE, validateMedicineInfoReply } from "./medicine-info-validator";

/** HSA preview (owner decision 2026-10-14): the medicine-information prompt (medicine-info-prompt.1) and its message builder. */

describe("medicine-info-prompt.1", () => {
  it("is versioned and states the role, the hard lines, NOT_FOUND, strict JSON and the closing sentence", () => {
    expect(MEDICINE_INFO_PROMPT_VERSION).toBe("medicine-info-prompt.1");
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/general medicine information for a diabetes self-care diary/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/return NOT_FOUND/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/Never give doses, amounts/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/start, stop, change, skip, double/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/Never diagnose/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toMatch(/strict JSON only/);
    expect(MEDICINE_INFO_SYSTEM_PROMPT).toContain(MEDICINE_INFO_DIRECTIONS_SENTENCE);
  });

  it("has few-shot examples including metformin and a non-medicine NOT_FOUND; every good reply passes the validator and every bad draft fails it", () => {
    expect(MEDICINE_INFO_FEW_SHOTS.map((shot) => shot.medicineName)).toEqual(expect.arrayContaining(["Metformin", "Chicken rice"]));
    expect(MEDICINE_INFO_FEW_SHOTS.find((shot) => shot.medicineName === "Chicken rice")?.reply.kind).toBe("NOT_FOUND");
    for (const shot of MEDICINE_INFO_FEW_SHOTS) {
      expect(validateMedicineInfoReply(shot.reply, { medicineName: shot.medicineName }).ok, shot.title).toBe(true);
      if (shot.badDraft) expect(validateMedicineInfoReply(shot.badDraft.reply, { medicineName: shot.medicineName }).ok, shot.title).toBe(false);
    }
  });

  it("builds exactly two messages: the system prompt and one user message holding only the name", () => {
    const messages = buildMedicineInfoPromptMessages({ task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin" });
    expect(messages).toEqual([
      { role: "system", text: MEDICINE_INFO_SYSTEM_PROMPT },
      { role: "user", text: '{"medicineName":"Metformin"}' },
    ]);
  });
});
