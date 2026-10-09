import { VOICE_ACCESS_HEADER } from "@/voice/trtc/trtc-usersig-contract";
import { VOICE_USERSIG_ENV } from "./voice-usersig-config";

/**
 * TEST-ONLY (Packet 13 slice, P13S S6a). Never imported by product code: the route imports only the handler, the configuration and the
 * signer. Every value here is synthetic (`TEST-ONLY-…`), not a deployment value and not a code default; the route fails closed while
 * any real value is missing.
 */
export const TEST_VOICE_ORIGIN = "http://localhost";
export const TEST_VOICE_PASSCODE = "TEST-ONLY-voice-passcode";
export const TEST_VOICE_SECRET = "TEST-ONLY-voice-signing-secret-not-a-secret";
export const TEST_VOICE_SDK_APP_ID = "1400000001";

export const TEST_VOICE_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  [VOICE_USERSIG_ENV.voiceCloud]: "on",
  [VOICE_USERSIG_ENV.allowedOrigins]: TEST_VOICE_ORIGIN,
  [VOICE_USERSIG_ENV.demoPasscode]: TEST_VOICE_PASSCODE,
  [VOICE_USERSIG_ENV.userSigTtlSeconds]: "300",
  [VOICE_USERSIG_ENV.maxSessionSeconds]: "90",
  [VOICE_USERSIG_ENV.dailyMinutesLimit]: "10",
  [VOICE_USERSIG_ENV.sdkAppId]: TEST_VOICE_SDK_APP_ID,
  [VOICE_USERSIG_ENV.secretKey]: TEST_VOICE_SECRET,
});

/** The headers of a same-origin browser POST from the test origin, with the entered passcode. */
export function testVoiceHeaders(passcode: string | null = TEST_VOICE_PASSCODE): Record<string, string> {
  return { "content-type": "application/json", Origin: TEST_VOICE_ORIGIN, "Sec-Fetch-Site": "same-origin", ...(passcode === null ? {} : { [VOICE_ACCESS_HEADER]: passcode }) };
}
