import { describe, it, expect } from "vitest";
import {
  createHelpInformationAdapter,
  telHref,
  whatsAppHref,
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

  it("returns the emotional support numbers (SOS, mindline) with their sources and check date", () => {
    const info = adapter.getHelpInformation();
    expect([info.sosNumber, info.sosWhatsAppNumber, info.mindlineNumber, info.mindlineWhatsAppNumber]).toEqual(["1767", "9151 1767", "1771", "6669 1771"]);
    expect([info.sosWebsite, info.mindlineWebsite]).toEqual(["https://www.sos.org.sg/", "https://www.mindline.sg/"]);
    expect(info.emotionalSupportCheckedOn).toBe("2026-10-14");
  });

  it("builds tel: and WhatsApp links from the numbers as shown", () => {
    expect([telHref("1767"), telHref("6262 6262")]).toEqual(["tel:1767", "tel:62626262"]);
    expect([whatsAppHref("9151 1767"), whatsAppHref("6669 1771")]).toEqual(["https://wa.me/6591511767", "https://wa.me/6566691771"]);
  });

  it("does not include the retired IMH helpline 6389 2222", () => {
    expect(JSON.stringify(adapter.getHelpInformation()).replace(/\s/g, "")).not.toContain("63892222");
  });

  it("does not include the 1777 number that SCDF is retiring", () => {
    expect(JSON.stringify(adapter.getHelpInformation())).not.toContain("1777");
  });
});
