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
});

export function createHelpInformationAdapter(): HelpInformationAdapter {
  return Object.freeze({
    getHelpInformation(): HelpInformation {
      return HELP_INFO;
    },
  });
}
