import { describe, it, expect } from "vitest";
import {
  createMedicationInformationAdapter,
  DEMO_MEDICATION_IDS,
  isSupportedMedicationId,
  DEMO_MEDICATION_REVIEWED_DATE,
} from "./medication-information-adapter";
import { enSGMessages } from "@/i18n/messages/en-SG";
import { zhSGMessages } from "@/i18n/messages/zh-SG";

describe("medication-information-adapter", () => {
  const adapter = createMedicationInformationAdapter();

  it("returns reviewed general info for insulin glargine (en-SG)", () => {
    const info = adapter.getGeneralInfo(
      DEMO_MEDICATION_IDS.glargine,
      enSGMessages,
      "en-SG",
    );
    expect(info.available).toBe(true);
    expect(info.displayName).toBe("Insulin glargine");
    expect(info.purpose).toContain("long-acting insulin");
    expect(info.use).toContain("once daily");
    expect(info.reviewedOnLabel).toContain(DEMO_MEDICATION_REVIEWED_DATE);
    expect(DEMO_MEDICATION_REVIEWED_DATE).toBe("2026-10-02");
    expect(info.sourceUrl).toBe(
      "https://www.healthhub.sg/medication-devices-and-treatment/medications/insulin-glargine",
    );
  });

  it("returns reviewed general info for insulin aspart (zh-SG)", () => {
    const info = adapter.getGeneralInfo(
      DEMO_MEDICATION_IDS.aspart,
      zhSGMessages,
      "zh-SG",
    );
    expect(info.available).toBe(true);
    // Medicine names are data and are not translated.
    expect(info.displayName).toBe("Insulin aspart");
    expect(info.purpose).toBe("Insulin aspart 是一种速效胰岛素，用于控制餐后血糖。");
    expect(info.use).toContain("注射到皮下脂肪组织");
    expect(info.sourceName).toBe("HealthHub");
    expect(info.sourceUrl).toContain("ch-api.healthhub.sg");
  });

  it("returns unavailable for an unknown medication ID", () => {
    const info = adapter.getGeneralInfo(
      "unknown-medicine",
      enSGMessages,
      "en-SG",
    );
    expect(info.available).toBe(false);
    expect(info.purpose).toBe("");
    expect(info.use).toBe("");
    expect(info.sourceUrl).toBe("");
  });

  it("does not recommend doses in general info", () => {
    const glargine = adapter.getGeneralInfo(
      DEMO_MEDICATION_IDS.glargine,
      enSGMessages,
      "en-SG",
    );
    const aspart = adapter.getGeneralInfo(
      DEMO_MEDICATION_IDS.aspart,
      enSGMessages,
      "en-SG",
    );
    expect(glargine.purpose).not.toMatch(/\d+\s*(mg|units|IU)/i);
    expect(glargine.use).not.toMatch(/take\s+\d+/i);
    expect(aspart.purpose).not.toMatch(/\d+\s*(mg|units|IU)/i);
    expect(aspart.use).not.toMatch(/take\s+\d+/i);
  });

  it("isSupportedMedicationId identifies known medicines", () => {
    expect(isSupportedMedicationId(DEMO_MEDICATION_IDS.glargine)).toBe(true);
    expect(isSupportedMedicationId(DEMO_MEDICATION_IDS.aspart)).toBe(true);
    expect(isSupportedMedicationId("unknown")).toBe(false);
  });
});
