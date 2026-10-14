/**
 * Help information adapter.
 *
 * Provides verified emergency and non-emergency contact information
 * for the hackathon demo. All numbers are source-bound to the
 * regulatory-compliance spec and the help copy matrix.
 *
 * This adapter does NOT assess symptoms, classify urgency, or
 * recommend treatment. It only surfaces contact information.
 */

export type HelpInformation = {
  /** Life-threatening emergency number. */
  emergencyNumber: string;
  /** Service that operates 995 and SMS 70995. */
  emergencyProvider: string;
  /** Accessible emergency SMS number. */
  emergencySmsNumber: string;
  /** Non-emergency nurse advice line. */
  nurseAdviceNumber: string;
  /** Website for verifying current info. */
  verifyWebsite: string;
  /** Date the numbers were last checked against the source. */
  checkedOn: string;
  /** Owner decision 2026-10-14 (distress safety): Samaritans of Singapore 24-hour hotline. */
  sosNumber: string;
  /** SOS CareText on WhatsApp (Singapore number). */
  sosWhatsAppNumber: string;
  /** mindline hotline (round the clock). */
  mindlineNumber: string;
  /** mindline on WhatsApp (Singapore number). */
  mindlineWhatsAppNumber: string;
  sosWebsite: string;
  mindlineWebsite: string;
  /** Date the emotional support numbers were last checked against their sources. */
  emotionalSupportCheckedOn: string;
};

export type HelpInformationAdapter = {
  getHelpInformation(): HelpInformation;
};

const HELP_INFO: HelpInformation = Object.freeze({
  emergencyNumber: "995",
  emergencyProvider: "SCDF",
  emergencySmsNumber: "70995",
  nurseAdviceNumber: "6262 6262",
  // Source and check date from the approved Packet 6 copy matrix (section 9).
  verifyWebsite:
    "https://www.scdf.gov.sg/home/about-scdf/emergency-medical-services",
  checkedOn: "2026-10-02",
  // Owner decision 2026-10-14: checked against https://www.sos.org.sg/ and https://www.mindline.sg/ (IMH 6389 2222 is retired and
  // routes to 1771, so it is not listed).
  sosNumber: "1767",
  sosWhatsAppNumber: "9151 1767",
  mindlineNumber: "1771",
  mindlineWhatsAppNumber: "6669 1771",
  sosWebsite: "https://www.sos.org.sg/",
  mindlineWebsite: "https://www.mindline.sg/",
  emotionalSupportCheckedOn: "2026-10-14",
});

/** A `tel:` link for a Singapore number as shown ("6262 6262" → "tel:62626262"). */
export function telHref(number: string): string {
  return `tel:${number.replace(/\s/g, "")}`;
}

/** A WhatsApp chat link for a Singapore number as shown ("9151 1767" → "https://wa.me/6591511767"). */
export function whatsAppHref(number: string): string {
  return `https://wa.me/65${number.replace(/\s/g, "")}`;
}

export function createHelpInformationAdapter(): HelpInformationAdapter {
  return Object.freeze({
    getHelpInformation(): HelpInformation {
      return HELP_INFO;
    },
  });
}
