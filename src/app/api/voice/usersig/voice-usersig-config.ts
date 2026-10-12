import { createHash, timingSafeEqual } from "node:crypto";
import { TRTC_EXCLUDED_AT_BUILD } from "@/config/build-exclusions";
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
 *   Owner decision 2026-10-12 (optional passcodes: "when JAGAON_AI_DEMO_PASSCODE or JAGAON_VOICE_DEMO_PASSCODE is empty or missing, no
 *   passcode is asked"): OPTIONAL. Missing, empty or whitespace-only means NO passcode is required (`passcodeDigest: null`; voice is
 *   otherwise configured as before and every other check is unchanged). A value that is present but invalid still means voice off
 *   (fail closed, as before). The probe reports only whether one is required (`passcodeRequired`), never a value.
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
 *
 * Web Speech (owner-approved scope 2026-10-11; draft, pending owner review): `JAGAON_VOICE_PROVIDERS` (VOICE_PROVIDERS_ENV) names the
 * enabled providers, comma separated, in order: `trtc`, `webspeech` (exact lower case, surrounding spaces trimmed, duplicates kept once).
 * Unset means `trtc` (today's behaviour). Any other value (an unknown or empty entry, an empty list) means voice off. `JAGAON_VOICE_CLOUD`
 * stays the master switch. The origins and the maximum session are required for every provider (the passcode is optional: Owner
 * decision 2026-10-12, optional passcodes); the TTL, the daily minutes and `TRTC_SDK_APP_ID` (and, at signing time, the secret) are
 * required ONLY when `trtc` is enabled: with `webspeech` alone
 * they are not read, and the TRTC credential POST refuses VOICE_DISABLED. When `trtc` is enabled and any of them is missing or invalid,
 * voice is off (for every provider, as a misconfiguration).
 *
 * Tencent build-time exclusion (owner-approved 2026-10-11): in a build made with `JAGAON_BUILD_EXCLUDE_TRTC=1` (the inlined
 * `TRTC_EXCLUDED_AT_BUILD`), `trtc` is removed from the enabled providers whatever the run-time list says: no TRTC value is read or
 * required, the probe never lists TRTC, and the credential POST refuses VOICE_DISABLED. A list that names only `trtc` (or is unset)
 * then enables nothing: voice is off.
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

/** Kept apart from VOICE_USERSIG_ENV (whose names are each required): this one is optional, unset meaning `trtc`. */
export const VOICE_PROVIDERS_ENV = "JAGAON_VOICE_PROVIDERS";
/** The deployment's provider names → the provider ids the probe reports. */
export const VOICE_PROVIDER_SETTING_IDS = Object.freeze({ trtc: "TRTC", webspeech: "WEB_SPEECH" } as const);
export type VoiceDeploymentProvider = (typeof VOICE_PROVIDER_SETTING_IDS)[keyof typeof VOICE_PROVIDER_SETTING_IDS];

export const VOICE_USERSIG_BOUNDS = Object.freeze({
  userSigTtlSeconds: Object.freeze({ min: 60, max: 3_600 }),
  maxSessionSeconds: Object.freeze({ min: 10, max: 900 }),
  dailyMinutesLimit: Object.freeze({ min: 1, max: 10_000 }),
});

type VoiceCommonConfig = Readonly<{
  voiceEnabled: true;
  /** The enabled providers, in the deployment's order (never empty). */
  providers: readonly VoiceDeploymentProvider[];
  allowedOrigins: readonly string[];
  /** Owner decision 2026-10-12 (optional passcodes): the configured passcode's digest, or null when none is configured (not required). */
  passcodeDigest: Uint8Array | null;
  maxSessionSeconds: number;
  /** Optional, off by default: whether the failed-passcode throttle may key by the Vercel platform client address. */
  trustVercelClientIp: boolean;
}>;

export type VoiceUserSigConfig =
  | (VoiceCommonConfig & Readonly<{ trtcEnabled: true; userSigTtlSeconds: number; dailyMinutesLimit: number; sdkAppId: number }>)
  | (VoiceCommonConfig & Readonly<{ trtcEnabled: false }>)
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

/** `JAGAON_VOICE_PROVIDERS`: unset → [TRTC]; a valid list → its providers in order (once each); anything else → null (voice off). */
export function parseVoiceProviders(value: string | undefined): readonly VoiceDeploymentProvider[] | null {
  if (value === undefined) return Object.freeze([VOICE_PROVIDER_SETTING_IDS.trtc]);
  const providers: VoiceDeploymentProvider[] = [];
  for (const entry of value.split(",").map((part) => part.trim())) {
    if (entry !== "trtc" && entry !== "webspeech") return null;
    const id = VOICE_PROVIDER_SETTING_IDS[entry];
    if (!providers.includes(id)) providers.push(id);
  }
  return providers.length > 0 ? Object.freeze(providers) : null;
}

export type VoiceConfigBuildOptions = Readonly<{ trtcExcludedAtBuild?: boolean }>;

/** The one parsed configuration. Every required value must be present and valid, else voice is off. The secret is not read here. */
export function parseVoiceUserSigConfig(environment: Environment, build: VoiceConfigBuildOptions = {}): VoiceUserSigConfig {
  if (read(environment, VOICE_USERSIG_ENV.voiceCloud) !== "on") return VOICE_OFF;
  const listed = parseVoiceProviders(read(environment, VOICE_PROVIDERS_ENV));
  // Tencent build-time exclusion: TRTC is never enabled in an excluded build.
  const excluded = build.trtcExcludedAtBuild ?? TRTC_EXCLUDED_AT_BUILD;
  const remaining = listed === null ? null : excluded ? listed.filter((id) => id !== VOICE_PROVIDER_SETTING_IDS.trtc) : listed;
  const providers = remaining === null || remaining.length === 0 ? null : Object.freeze([...remaining]);
  const allowedOrigins = parseOrigins(read(environment, VOICE_USERSIG_ENV.allowedOrigins));
  // Owner decision 2026-10-12 (optional passcodes): missing, empty or whitespace-only → none required; present but invalid → voice off.
  const passcode = read(environment, VOICE_USERSIG_ENV.demoPasscode);
  const passcodeConfigured = passcode !== undefined && passcode.trim().length > 0;
  const maxSessionSeconds = integerIn(read(environment, VOICE_USERSIG_ENV.maxSessionSeconds), VOICE_USERSIG_BOUNDS.maxSessionSeconds);
  if (providers === null || allowedOrigins === null || (passcodeConfigured && !PASSCODE.test(passcode)) || maxSessionSeconds === null) return VOICE_OFF;
  const trustVercelClientIp = read(environment, VOICE_USERSIG_ENV.trustVercelClientIp) === "on";
  const common = { voiceEnabled: true as const, providers, allowedOrigins, passcodeDigest: passcodeConfigured ? digest(passcode) : null, maxSessionSeconds, trustVercelClientIp };
  // Web Speech alone: no TRTC value is read or required.
  if (!providers.includes(VOICE_PROVIDER_SETTING_IDS.trtc)) return Object.freeze({ ...common, trtcEnabled: false as const });
  const userSigTtlSeconds = integerIn(read(environment, VOICE_USERSIG_ENV.userSigTtlSeconds), VOICE_USERSIG_BOUNDS.userSigTtlSeconds);
  const dailyMinutesLimit = integerIn(read(environment, VOICE_USERSIG_ENV.dailyMinutesLimit), VOICE_USERSIG_BOUNDS.dailyMinutesLimit);
  const appId = read(environment, VOICE_USERSIG_ENV.sdkAppId);
  const sdkAppId = appId !== undefined && /^[1-9]\d{0,9}$/.test(appId) ? Number(appId) : null;
  if (userSigTtlSeconds === null || dailyMinutesLimit === null || sdkAppId === null) return VOICE_OFF;
  return Object.freeze({ ...common, trtcEnabled: true as const, userSigTtlSeconds, dailyMinutesLimit, sdkAppId });
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

/**
 * Owner decision 2026-10-12 (optional passcodes): whether a demo passcode is required. True unless voice is on with no passcode
 * configured (a configuration that is off answers true: nothing is granted there anyway). The only passcode fact the probe reports.
 */
export function voicePasscodeRequired(config: VoiceUserSigConfig): boolean {
  return !config.voiceEnabled || config.passcodeDigest !== null;
}

/**
 * Access: the presented passcode's SHA-256 digest equals the configured one (constant-time comparison of equal-length digests).
 * Owner decision 2026-10-12 (optional passcodes): with no passcode configured, access is granted (whatever is presented; nothing is
 * compared or echoed). Voice off is never granted. The switch, origin, throttle, rate and minute checks around it are unchanged.
 */
export function voiceAccessGranted(config: VoiceUserSigConfig, headers: Headers): boolean {
  if (!config.voiceEnabled) return false;
  if (config.passcodeDigest === null) return true;
  const presented = headers.get(VOICE_ACCESS_HEADER);
  if (presented === null || presented.length === 0 || presented.length > MAX_PRESENTED_PASSCODE_CHARS) return false;
  return timingSafeEqual(digest(presented), config.passcodeDigest);
}
