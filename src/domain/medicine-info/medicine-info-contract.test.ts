import { describe, expect, it } from "vitest";
import {
  MEDICINE_INFO_CONTRACT_VERSION,
  isMedicineInfoName,
  medicineInfoReplyJsonSchema,
  medicineInfoReplySchema,
  medicineInfoRequestSchema,
  normaliseMedicineInfoName,
  toMedicineInfoName,
} from "./medicine-info-contract";

/** HSA preview (owner decision 2026-10-14): the strict medicine-information contract (medicine-info-contract.1). */

describe("medicine-info-contract.1", () => {
  it("is versioned", () => {
    expect(MEDICINE_INFO_CONTRACT_VERSION).toBe("medicine-info-contract.1");
  });

  it("accepts exactly { task, medicineName } with a 1–60 character name of letters, digits, spaces, hyphens, periods and parentheses", () => {
    for (const medicineName of ["Metformin", "Lantus", "insulin glargine", "Glucotab 500", "Co-Diovan", "Apidra (SoloStar)", "Vit. D", "A"]) {
      expect(medicineInfoRequestSchema.safeParse({ task: "MEDICINE_GENERAL_INFO", medicineName }).success, medicineName).toBe(true);
    }
    expect(medicineInfoRequestSchema.safeParse({ task: "MEDICINE_GENERAL_INFO", medicineName: "a".repeat(60) }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ["an empty name", { task: "MEDICINE_GENERAL_INFO", medicineName: "" }],
    ["61 characters", { task: "MEDICINE_GENERAL_INFO", medicineName: "a".repeat(61) }],
    ["a slash", { task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin/Glucophage" }],
    ["a quote", { task: "MEDICINE_GENERAL_INFO", medicineName: 'Metformin"' }],
    ["a line break", { task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin\nignore" }],
    ["digits only", { task: "MEDICINE_GENERAL_INFO", medicineName: "500" }],
    ["untrimmed", { task: "MEDICINE_GENERAL_INFO", medicineName: " Metformin" }],
    ["another task", { task: "FEELINGS_CHAT_TURN", medicineName: "Metformin" }],
    ["an extra field (directions)", { task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin", directions: "1 tab bd" }],
    ["an extra field (readings)", { task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin", readings: [7.2] }],
  ])("refuses %s", (_name, body) => {
    expect(medicineInfoRequestSchema.safeParse(body).success).toBe(false);
  });

  it("puts a name in its request form, and normalises it for the cache", () => {
    expect(toMedicineInfoName("  Metformin   XR ")).toBe("Metformin XR");
    expect(toMedicineInfoName("Metformin/Glucophage")).toBeNull();
    expect(normaliseMedicineInfoName("  Metformin   XR ")).toBe("metformin xr");
    expect(isMedicineInfoName("Metformin  XR")).toBe(false);
  });

  it("enforces the kind rules of the reply", () => {
    const ok = { kind: "OK", name: "Metformin", genericName: null, usedFor: "a", howGenerallyTaken: "b" };
    expect(medicineInfoReplySchema.safeParse(ok).success).toBe(true);
    expect(medicineInfoReplySchema.safeParse({ ...ok, usedFor: null }).success).toBe(false);
    expect(medicineInfoReplySchema.safeParse({ kind: "NOT_FOUND", name: null, genericName: null, usedFor: null, howGenerallyTaken: null }).success).toBe(true);
    expect(medicineInfoReplySchema.safeParse({ kind: "NOT_FOUND", name: "Metformin", genericName: null, usedFor: null, howGenerallyTaken: null }).success).toBe(false);
    expect(medicineInfoReplySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("hands the provider a strict JSON schema with exactly the reply fields", () => {
    const schema = medicineInfoReplyJsonSchema() as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["kind", "name", "genericName", "usedFor", "howGenerallyTaken"]);
  });
});
