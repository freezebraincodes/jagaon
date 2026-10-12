import { createHash, timingSafeEqual } from "node:crypto";
import { AI_SHELL_ACCESS_HEADER } from "@/application/ai/ai-shell-route-contract";

/**
 * Packet 11C Addendum C, Task C6 (owner approval of Addendum C; C6 amendment 2026-10-08): the deployment configuration of POST
 * /api/ai/shell. Server-only. It is read from the server environment the route module hands to the handler (never `NEXT_PUBLIC_`), parsed
 * once into ONE validated object, and every missing or invalid value means "not configured", which the route answers with a closed
 * refusal before any credential read (the browser then keeps the deterministic wording). No value has a code default: the owner sets the
 * switch, the allowed origins, the demo passcode and the daily limit at deployment.
 *
 * - `JAGAON_REMOTE_AI`: the server-side remote-AI switch. On only for the exact value `on`; anything else, or missing, is off. It can
 *   only restrict: activation and request-class qualification are still required.
 * - `JAGAON_AI_ALLOWED_ORIGINS`: the exact allowed origins, comma separated (`scheme://host[:port]`, http or https, no path, no
 *   wildcard). Any invalid entry invalidates the list; a missing list refuses every request. This is origin protection, not
 *   authentication.
 * - `JAGAON_AI_DEMO_PASSCODE`: the demo passcode (8 to 128 visible ASCII characters, so it travels as an HTTP header). Only its SHA-256
 *   digest is kept; the passcode is never returned, logged or stored. The browser sends the passcode the person entered in the
 *   `x-jagaon-demo-passcode` header; the route compares the two digests in constant time.
 *   Owner decision 2026-10-12 (optional passcodes: "when JAGAON_AI_DEMO_PASSCODE or JAGAON_VOICE_DEMO_PASSCODE is empty or missing, no
 *   passcode is asked"): OPTIONAL. Missing, empty or whitespace-only means no passcode is required (`passcodeRequired: false`) and
 *   access authorization grants without one; every other check and the order are unchanged. A value that is present but invalid keeps
 *   the fail-closed behaviour (`passcodeRequired: true` with no digest: every request is refused ACCESS_DENIED). The browser learns
 *   only the boolean, from `GET /api/ai/shell` (ai-shell-handler.ts).
 * - `JAGAON_AI_DAILY_SPEND_LIMIT_USD`: the daily spend limit in USD (a positive decimal with at most 6 decimals, below 1,000,000), held as
 *   whole micro-USD for the per-instance spend ledger (ai-spend-ledger.ts). The owner's target is entered here at deployment.
 */
/**
 * CL3 contract re-freeze (Task RF): the label of the C6 server access and spend policy (the switch, origin protection, the demo passcode,
 * the per-instance daily spend guard, the route's check order and the not-sent marker; ai-shell-handler.ts). The contract freeze pins
 * the variable names and the order, never a value. Never model-facing.
 */
export const AI_SHELL_ACCESS_SPEND_POLICY_VERSION = "ai-shell-access-spend.11c.1";

export const AI_SHELL_DEPLOYMENT_ENV = Object.freeze({
  remoteAi: "JAGAON_REMOTE_AI",
  allowedOrigins: "JAGAON_AI_ALLOWED_ORIGINS",
  demoPasscode: "JAGAON_AI_DEMO_PASSCODE",
  dailySpendLimitUsd: "JAGAON_AI_DAILY_SPEND_LIMIT_USD",
} as const);

export type AiShellDeploymentConfig = Readonly<{
  remoteAiEnabled: boolean;
  /** The exact allowed origins, or null when missing or invalid (every request is refused). */
  allowedOrigins: readonly string[] | null;
  /**
   * Owner decision 2026-10-12 (optional passcodes): false only when no passcode is configured (missing, empty or whitespace-only); a
   * present value, valid or not, is required.
   */
  passcodeRequired: boolean;
  /** The SHA-256 digest of the configured passcode (never the passcode), or null when missing or invalid. */
  passcodeDigest: Uint8Array | null;
  /** The daily spend limit in whole micro-USD, or null when missing or invalid. */
  dailySpendLimitMicroUsd: number | null;
}>;

const PASSCODE = /^[\x21-\x7e]{8,128}$/;
const USD = /^(0|[1-9]\d{0,5})(?:\.(\d{1,6}))?$/;
/** The largest presented passcode the route hashes; a longer header is refused unread. */
const MAX_PRESENTED_PASSCODE_CHARS = 1_024;

const digest = (value: string): Uint8Array => new Uint8Array(createHash("sha256").update(value, "utf8").digest());

function read(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  try {
    const value = environment[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseOrigins(value: string | undefined): readonly string[] | null {
  if (value === undefined) return null;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (entry.includes("*")) return null;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== entry) return null;
  }
  return Object.freeze(entries);
}

function parseMicroUsd(value: string | undefined): number | null {
  const match = value === undefined ? null : USD.exec(value);
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}

/** The one parsed, validated deployment configuration (a throwing read is a missing value). */
export function parseAiShellDeploymentConfig(environment: Readonly<Record<string, string | undefined>>): AiShellDeploymentConfig {
  const passcode = read(environment, AI_SHELL_DEPLOYMENT_ENV.demoPasscode);
  // Owner decision 2026-10-12 (optional passcodes): only a missing, empty or whitespace-only value means "none required".
  const passcodeRequired = passcode !== undefined && passcode.trim().length > 0;
  return Object.freeze({
    remoteAiEnabled: read(environment, AI_SHELL_DEPLOYMENT_ENV.remoteAi) === "on",
    allowedOrigins: parseOrigins(read(environment, AI_SHELL_DEPLOYMENT_ENV.allowedOrigins)),
    passcodeRequired,
    passcodeDigest: passcodeRequired && PASSCODE.test(passcode) ? digest(passcode) : null,
    dailySpendLimitMicroUsd: parseMicroUsd(read(environment, AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd)),
  });
}

/**
 * Origin protection (not authentication): the request's `Origin` is exactly one of the configured origins AND the browser marks it
 * `Sec-Fetch-Site: same-origin`. No configured list refuses every request.
 */
export function originAllowed(config: AiShellDeploymentConfig, headers: Headers): boolean {
  const origin = headers.get("origin");
  return config.allowedOrigins !== null && origin !== null && config.allowedOrigins.includes(origin) && headers.get("Sec-Fetch-Site") === "same-origin";
}

/**
 * Access authorization: the presented demo passcode (the `x-jagaon-demo-passcode` header) matches the configured one. Both are hashed to
 * equal-length SHA-256 digests and compared in constant time. An invalid configured passcode refuses every request.
 * Owner decision 2026-10-12 (optional passcodes): no passcode configured (`passcodeRequired: false`) grants access without one (a
 * presented header is neither compared nor echoed). The switch and origin checks before it, and everything after it, are unchanged.
 */
export function accessGranted(config: AiShellDeploymentConfig, headers: Headers): boolean {
  if (!config.passcodeRequired) return true;
  const presented = headers.get(AI_SHELL_ACCESS_HEADER);
  if (config.passcodeDigest === null || presented === null || presented.length === 0 || presented.length > MAX_PRESENTED_PASSCODE_CHARS) return false;
  return timingSafeEqual(digest(presented), config.passcodeDigest);
}
