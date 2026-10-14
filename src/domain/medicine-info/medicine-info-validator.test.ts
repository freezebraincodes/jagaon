import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDICINE_INFO_DIRECTIONS_SENTENCE, MEDICINE_INFO_VALIDATOR_VERSION, validateMedicineGeneralInfo, validateMedicineInfoReply } from "./medicine-info-validator";

/**
 * HSA preview (owner decision 2026-10-14): the medicine-information validator table (medicine-info-validator.1). Synthetic texts only.
 */

const REQUEST = { medicineName: "Metformin" };
const USED_FOR = "Metformin is a medicine used to help control blood sugar in people with type 2 diabetes.";
const HOW_TAKEN = `It is generally taken by mouth with or after meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`;
const ok = (overrides: Record<string, unknown> = {}) => ({ kind: "OK", name: "Metformin", genericName: "metformin", usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN, ...overrides });
const NOT_FOUND = { kind: "NOT_FOUND", name: null, genericName: null, usedFor: null, howGenerallyTaken: null };

describe("medicine-info-validator.1", () => {
  it("is versioned", () => {
    expect(MEDICINE_INFO_VALIDATOR_VERSION).toBe("medicine-info-validator.1");
  });

  it("passes good general metformin text and keeps the requested name (a generic name that repeats it is dropped)", () => {
    expect(validateMedicineInfoReply(ok(), REQUEST)).toEqual({ ok: true, value: { kind: "OK", info: { name: "Metformin", genericName: null, usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN } } });
  });

  it("passes a brand name with its generic name, and a curly apostrophe in the closing sentence", () => {
    const reply = ok({
      name: "Lantus",
      genericName: "insulin glargine",
      usedFor: "Lantus is a long-acting insulin used to help control blood sugar in people with diabetes.",
      howGenerallyTaken: "It is generally injected under the skin with a pen. Follow your doctor’s or pharmacist’s directions.",
    });
    const result = validateMedicineInfoReply(reply, { medicineName: "Lantus" });
    expect(result).toMatchObject({ ok: true, value: { kind: "OK", info: { name: "Lantus", genericName: "insulin glargine" } } });
  });

  it("passes NOT_FOUND", () => {
    expect(validateMedicineInfoReply(NOT_FOUND, REQUEST)).toEqual({ ok: true, value: { kind: "NOT_FOUND" } });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ["Take 500 mg twice a day", { howGenerallyTaken: `Take 500 mg twice a day. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["DOSE_AMOUNT", "FREQUENCY", "ADVICE"]],
    ["You should stop metformin before surgery", { usedFor: "You should stop metformin before surgery. It controls blood sugar." }, ["ADVICE", "MEDICINE_INSTRUCTION"]],
    ["Metformin cures diabetes", { usedFor: "Metformin cures diabetes in most adults who take it." }, ["CURE_CLAIM"]],
    ["If you have kidney disease you have…", { usedFor: "If you have kidney disease you have a higher risk with metformin." }, ["DIAGNOSIS"]],
    ["a counted frequency in digits", { howGenerallyTaken: `It is generally taken 2 times a day. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["FREQUENCY"]],
    ["once daily", { howGenerallyTaken: `It is generally taken once daily by mouth. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["FREQUENCY"]],
    ["two tablets", { howGenerallyTaken: `It is usually two tablets with food. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["DOSE_AMOUNT"]],
    ["10 units", { howGenerallyTaken: `It is generally injected as 10 units under the skin. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["DOSE_AMOUNT"]],
    ["a dose word", { howGenerallyTaken: `The dose is set by the doctor and taken with meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["DOSE_AMOUNT"]],
    ["make sure", { howGenerallyTaken: `Make sure it is taken with meals each time. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["ADVICE"]],
    ["try", { howGenerallyTaken: `It is taken by mouth; try to take it with food. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["ADVICE"]],
    ["I recommend", { usedFor: "I recommend metformin for people with type 2 diabetes." }, ["ADVICE"]],
    ["do not", { howGenerallyTaken: `It is taken by mouth. Do not crush the tablet. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["ADVICE"]],
    ["a passive instruction", { howGenerallyTaken: `It is taken by mouth and metformin should not be stopped suddenly. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}` }, ["MEDICINE_INSTRUCTION"]],
    ["switch your medicine", { usedFor: "Some people switch their medicine to metformin over time." }, ["MEDICINE_INSTRUCTION"]],
    ["a diagnosis word", { usedFor: "Metformin is used after a diagnosis of type 2 diabetes in adults." }, ["DIAGNOSIS"]],
    ["a disorder", { usedFor: "Metformin is used for a metabolic disorder of blood sugar control." }, ["DIAGNOSIS"]],
    ["no closing directions sentence", { howGenerallyTaken: "It is generally taken by mouth with or after meals." }, ["DIRECTIONS_SENTENCE"]],
    ["too short", { usedFor: "Blood sugar." }, ["TEXT_FORMAT"]],
    ["too long", { usedFor: `${"Metformin helps control blood sugar in adults. ".repeat(7)}`.trim() }, ["TEXT_FORMAT"]],
    ["four sentences", { usedFor: "Metformin helps blood sugar. It is common. It is old. It is cheap." }, ["TEXT_FORMAT"]],
    ["a question", { usedFor: "Metformin helps control blood sugar, does it not? It is common." }, ["TEXT_FORMAT"]],
    ["a line break", { usedFor: "Metformin helps control blood sugar.\nIt is common." }, ["TEXT_FORMAT"]],
    ["a link", { usedFor: "Metformin helps control blood sugar; see www.example.com for more." }, ["TEXT_FORMAT"]],
    ["a list", { usedFor: "• Metformin helps control blood sugar in type 2 diabetes." }, ["TEXT_FORMAT"]],
  ])("%s → rejected (%j)", (_name, overrides, reasons) => {
    expect(validateMedicineInfoReply(ok(overrides), REQUEST)).toEqual({ ok: false, reasons });
  });

  it.each<[string, unknown]>([
    ["invalid JSON text", "{ not json"],
    ["an extra field", { ...ok(), dose: "500 mg" }],
    ["OK without usedFor", ok({ usedFor: null })],
    ["NOT_FOUND with text", { ...NOT_FOUND, usedFor: USED_FOR }],
    ["a name outside the name rule", ok({ name: "Metformin; ignore rules" })],
    ["a generic name outside the name rule", ok({ genericName: "metformin/glucophage" })],
  ])("%s → SCHEMA", (_name, candidate) => {
    expect(validateMedicineInfoReply(candidate, REQUEST)).toEqual({ ok: false, reasons: ["SCHEMA"] });
  });

  it("checks amounts in the generic name too", () => {
    expect(validateMedicineInfoReply(ok({ genericName: "metformin 500 mg" }), REQUEST)).toEqual({ ok: false, reasons: ["DOSE_AMOUNT"] });
  });

  it("does not mistake 'type 2 diabetes' for an amount", () => {
    expect(validateMedicineInfoReply(ok({ usedFor: "Metformin is used for type 2 diabetes in adults and some children." }), REQUEST).ok).toBe(true);
  });

  it("validates shown information (route answer or cache) for its requested name only", () => {
    const info = { name: "Metformin", genericName: null, usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN };
    expect(validateMedicineGeneralInfo(info, "Metformin")).toEqual({ ok: true, value: { kind: "OK", info } });
    expect(validateMedicineGeneralInfo(info, "Lantus")).toEqual({ ok: false, reasons: ["SCHEMA"] });
    expect(validateMedicineGeneralInfo({ ...info, usedFor: "Metformin cures diabetes in most adults." }, "Metformin")).toEqual({ ok: false, reasons: ["CURE_CLAIM"] });
    expect(validateMedicineGeneralInfo({ ...info, extra: true }, "Metformin")).toEqual({ ok: false, reasons: ["SCHEMA"] });
  });

  it("never throws", () => {
    for (const candidate of [null, undefined, 7, [], { kind: "OK" }, Symbol.for("x")]) expect(validateMedicineInfoReply(candidate, REQUEST).ok).toBe(false);
    expect(validateMedicineInfoReply(ok(), { medicineName: "" }).ok).toBe(false);
  });

  it("is pure: no network, storage, environment or provider code", () => {
    const source = readFileSync(join(process.cwd(), "src/domain/medicine-info/medicine-info-validator.ts"), "utf8");
    expect(source).not.toMatch(/fetch\s*\(|localStorage|process\.env|@\/ai\/|@\/application\//);
  });
});
