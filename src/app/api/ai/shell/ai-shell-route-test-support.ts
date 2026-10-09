import { AI_SHELL_ACCESS_HEADER } from "@/application/ai/ai-shell-route-contract";
import { AI_SHELL_DEPLOYMENT_ENV } from "./ai-shell-deployment-config";

/**
 * TEST-ONLY (Packet 11C Addendum C, Task C6). Never imported by product code: the route and browser graphs exclude this module (pinned in
 * packet-11a-manifest.test.ts). Every value here is a test value, not a deployment value or a code default: the owner sets the real
 * switch, allowed origins, passcode and daily limit at deployment, and the route fails closed while any of them is missing.
 *
 * Tests that reach the provider call through `/api/ai/shell` add `TEST_DEPLOYMENT_ENVIRONMENT` to the handler's environment and send the
 * headers a same-origin browser request carries (`testBrowserHeaders`).
 */
export const TEST_ORIGIN = "http://localhost";
export const TEST_PASSCODE = "TEST-ONLY-passcode-not-a-secret";
/** A test-only daily limit (USD); unrelated to any owner value. */
export const TEST_DAILY_LIMIT_USD = "0.1";

export const TEST_DEPLOYMENT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  [AI_SHELL_DEPLOYMENT_ENV.remoteAi]: "on",
  [AI_SHELL_DEPLOYMENT_ENV.allowedOrigins]: TEST_ORIGIN,
  [AI_SHELL_DEPLOYMENT_ENV.demoPasscode]: TEST_PASSCODE,
  [AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd]: TEST_DAILY_LIMIT_USD,
});

/** The headers a same-origin browser POST from the test origin carries, with the entered passcode. */
export function testBrowserHeaders(passcode: string | null = TEST_PASSCODE): Record<string, string> {
  return { Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-origin", ...(passcode === null ? {} : { [AI_SHELL_ACCESS_HEADER]: passcode }) };
}
