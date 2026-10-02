import { describe, it, expect } from "vitest";
import {
  createHelpInformationAdapter,
} from "./help-information-adapter";

describe("help-information-adapter", () => {
  const adapter = createHelpInformationAdapter();

  it("returns emergency number 995", () => {
    expect(adapter.getHelpInformation().emergencyNumber).toBe("995");
  });

  it("returns accessible emergency SMS number 70995", () => {
    expect(adapter.getHelpInformation().emergencySmsNumber).toBe("70995");
  });

  it("returns NurseFirst number 6262 6262", () => {
    expect(adapter.getHelpInformation().nurseAdviceNumber).toBe("6262 6262");
  });

  it("returns SCDF website for verification", () => {
    expect(adapter.getHelpInformation().verifyWebsite).toBe(
      "https://www.scdf.gov.sg/home/about-scdf/emergency-medical-services",
    );
    expect(adapter.getHelpInformation().checkedOn).toBe("2026-10-02");
  });

  it("does not include the 1777 number that SCDF is retiring", () => {
    expect(JSON.stringify(adapter.getHelpInformation())).not.toContain("1777");
  });
});
