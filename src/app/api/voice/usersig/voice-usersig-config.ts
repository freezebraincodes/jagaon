import { createHash, timingSafeEqual } from "node:crypto";
import { VOICE_ACCESS_HEADER } from "@/voice/trtc/trtc-usersig-contract";

/**
 * Packet 13 slice (P13S, S6a): the deployment configuration of `POST /api/voice/usersig`. Server-only. Parsed once from the server
 * environment the route module hands over (never `NEXT_PUBLIC_`) into ONE frozen object. No value has a code default: any missing or
 * invalid value means `voiceEnabled: false`, and the route refuses with VOICE_DISABLED before any secret read. The ranges below are
 * validation bounds, not defaults (the owner may adjust them).
 *
 * Voice has its own names, separate from the AI wording route (owner decision "Voice access", 2026-10-09; open decision D5): the owner
 * may set identical origin and passcode values. The name table is one frozen object, so a later change is one line.
 *
 * - `JAGAON_VOICE_CLOUD`: the switch, on only for the exact value `on`.
 * - `JAGAON_VOICE_ALLOWED_ORIGINS`: exact origins, comma separated (`scheme://host[:port]`, http or https, no path, no wildcard); any
 *   invalid entry invalidates the list. Origin protection, not authentication.
 * - `JAGAON_VOICE_DEMO_PASSCODE`: 8 to 128 visible ASCII characters; only its SHA-256 digest is kept, compared in constant time.
 * - `JAGAON_VOICE_USERSIG_TTL_SECONDS`: integer 60 to 3600 (UserSig lifetime).
 * - `JAGAON_VOICE_MAX_SESSION_SECONDS`: integer 10 to 900 (maximum microphone session, enforced by the client controller).
 * - `JAGAON_VOICE_DAILY_MINUTES_LIMIT`: integer 1 to 10000 (best-effort per-instance daily guard, voice-minute-ledger.ts).
 * - `TRTC_SDK_APP_ID`: positive integer of at most 10 digits.
 * - `JAGAON_TRUST_VERCEL_CLIENT_IP`: trust the Vercel platform client-address header
 *   (`x-real-ip`) for the failed-passcode throttle. On only for the exact value `on`; OPTIONAL and OFF by default (missing does not
 *   turn voice off). Set it only on a Vercel deployment, where the platform sets the header; on localhost or any other hosting a
 *   client can forge it, so every client then shares one throttle bucket.
 * - `TRTC_SDK_SECRET_KEY`: the signing secret. NOT read by `parseVoiceUserSigConfig`: only `readTrtcSecretKey`, which the handler calls
 *   last (after every refusal and the minute reservation). Never returned, logged or stored.
 */
export const VOICE_USERSIG_POLICY_VERSION = "voice-usersig-access.13s.1";

export const VOICE_USERSIG_ENV = Object.freeze({
  voiceCloud: "JAGAON_VOICE_CLOUD",
  allowedOrigins: "JAGAON_VOICE_ALLOWED_ORIGINS",
  demoPasscode: "JAGAON_VOICE_DEMO_PASSCODE",
  userSigTtlSeconds: "JAGAON_VOICE_USERSIG_TTL_SECONDS",
  maxSessionSeconds: "JAGAON_VOICE_MAX_SESSION_SECONDS",
  dailyMinutesLimit: "JAGAON_VOICE_DAILY_MINUTES_LIMIT",
  sdkAppId: "TRTC_SDK_APP_ID",
  secretKey: "TRTC_SDK_SECRET_KEY",
  trustVercelClientIp: "JAGAON_TRUST_VERCEL_CLIENT_IP",
} as const);

export const VOICE_USERSIG_BOUNDS = Object.freeze({
  userSigTtlSeconds: Object.freeze({ min: 60, max: 3_600 }),
  maxSessionSeconds: Object.freeze({ min: 10, max: 900 }),
  dailyMinutesLimit: Object.freeze({ min: 1, max: 10_000 }),
});

export type VoiceUserSigConfig =
  | Readonly<{
      voiceEnabled: true;
      allowedOrigins: readonly string[];
      passcodeDigest: Uint8Array;
      userSigTtlSeconds: number;
      maxSessionSeconds: number;
      dailyMinutesLimit: number;
      sdkAppId: number;
      /** Optional, off by default: whether the failed-passcode throttle may key by the Vercel platform client address. */
      trustVercelClientIp: boolean;
    }>
  | Readonly<{ voiceEnabled: false }>;

type Environment = Readonly<Record<string, string | undefined>>;

const PASSCODE = /^[\x21-\x7e]{8,128}$/;
const SECRET = /^[\x21-\x7e]{16,256}$/;
const MAX_PRESENTED_PASSCODE_CHARS = 1_024;
const VOICE_OFF: VoiceUserSigConfig = Object.freeze({ voiceEnabled: false });

const digest = (value: string): Uint8Array => new Uint8Array(createHash("sha256").update(value, "utf8").digest());

function read(environment: Environment, name: string): string | undefined {
  try {
    const value = environment[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function integerIn(value: string | undefined, bounds: Readonly<{ min: number; max: number }>): number | null {
  if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= bounds.min && parsed <= bounds.max ? parsed : null;
}

function parseOrigins(value: string | undefined): readonly string[] | null {
  if (value === undefined) return null;
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry.length === 0 || entry.includes("*")) return null;
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

/** The one parsed configuration. Every value must be present and valid, else voice is off. The secret is not read here. */
export function parseVoiceUserSigConfig(environment: Environment): VoiceUserSigConfig {
  if (read(environment, VOICE_USERSIG_ENV.voiceCloud) !== "on") return VOICE_OFF;
  const allowedOrigins = parseOrigins(read(environment, VOICE_USERSIG_ENV.allowedOrigins));
  const passcode = read(environment, VOICE_USERSIG_ENV.demoPasscode);
  const userSigTtlSeconds = integerIn(read(environment, VOICE_USERSIG_ENV.userSigTtlSeconds), VOICE_USERSIG_BOUNDS.userSigTtlSeconds);
  const maxSessionSeconds = integerIn(read(environment, VOICE_USERSIG_ENV.maxSessionSeconds), VOICE_USERSIG_BOUNDS.maxSessionSeconds);
  const dailyMinutesLimit = integerIn(read(environment, VOICE_USERSIG_ENV.dailyMinutesLimit), VOICE_USERSIG_BOUNDS.dailyMinutesLimit);
  const appId = read(environment, VOICE_USERSIG_ENV.sdkAppId);
  const sdkAppId = appId !== undefined && /^[1-9]\d{0,9}$/.test(appId) ? Number(appId) : null;
  if (allowedOrigins === null || passcode === undefined || !PASSCODE.test(passcode) || userSigTtlSeconds === null || maxSessionSeconds === null || dailyMinutesLimit === null || sdkAppId === null) {
    return VOICE_OFF;
  }
  const trustVercelClientIp = read(environment, VOICE_USERSIG_ENV.trustVercelClientIp) === "on";
  return Object.freeze({ voiceEnabled: true, allowedOrigins, passcodeDigest: digest(passcode), userSigTtlSeconds, maxSessionSeconds, dailyMinutesLimit, sdkAppId, trustVercelClientIp });
}

/** The signing secret, read only when the handler is about to sign; null when missing or not visible ASCII (16 to 256). */
export function readTrtcSecretKey(environment: Environment): string | null {
  const value = read(environment, VOICE_USERSIG_ENV.secretKey);
  return value !== undefined && SECRET.test(value) ? value : null;
}

/** Origin protection: `Origin` is exactly one configured origin AND the browser marks the request `Sec-Fetch-Site: same-origin`. */
export function voiceOriginAllowed(config: VoiceUserSigConfig, headers: Headers): boolean {
  const origin = headers.get("origin");
  return config.voiceEnabled && origin !== null && config.allowedOrigins.includes(origin) && headers.get("Sec-Fetch-Site") === "same-origin";
}

/** Review I-5: the availability probe answers only a request the browser did not mark cross-site (the header is absent or same-origin). */
export function voiceProbeSiteAllowed(headers: Headers): boolean {
  const site = headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

/** Access: the presented passcode's SHA-256 digest equals the configured one (constant-time comparison of equal-length digests). */
export function voiceAccessGranted(config: VoiceUserSigConfig, headers: Headers): boolean {
  const presented = headers.get(VOICE_ACCESS_HEADER);
  if (!config.voiceEnabled || presented === null || presented.length === 0 || presented.length > MAX_PRESENTED_PASSCODE_CHARS) return false;
  return timingSafeEqual(digest(presented), config.passcodeDigest);
}
