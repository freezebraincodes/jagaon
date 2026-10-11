import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  VOICE_ROOM_ID_PATTERN,
  VOICE_USER_ID_PATTERN,
  VOICE_USERSIG_MAX_BODY_BYTES,
  VOICE_USERSIG_PATTERN,
  voiceUserSigRequestSchema,
  type VoiceAvailabilityResponse,
  type VoiceUserSigRefusalReason,
  type VoiceUserSigResponse,
} from "@/voice/trtc/trtc-usersig-contract";
import { parseVoiceUserSigConfig, readTrtcSecretKey, type VoiceConfigBuildOptions, voiceAccessGranted, voiceOriginAllowed, voiceProbeSiteAllowed, type VoiceUserSigConfig } from "./voice-usersig-config";
import { InMemoryDailyMinuteLedger, voiceSessionMinutes, type VoiceMinuteLedger, type VoiceMinuteReservation } from "./voice-minute-ledger";

/**
 * Packet 13 slice (P13S, S6a): `POST /api/voice/usersig`, the short-lived TRTC credential for ONE voice session. Server-only. It issues a
 * credential only; it never sees audio or transcripts and calls no Tencent API.
 *
 * Order (every refusal comes before the secret read and issues nothing):
 *   1. method, content type, body cap and strict JSON `{}` (405 / 415 / 413 / 400, FAILED PAYLOAD_INVALID);
 *   2. the switch and a fully valid configuration (VOICE_DISABLED);
 *   3. Origin in the configured list AND `Sec-Fetch-Site: same-origin` (ORIGIN_REJECTED);
 *   4. the failed-passcode throttle (RATE_LIMITED, owner decision #1), then the demo passcode, constant-time (ACCESS_DENIED);
 *   5. the per-instance request rate (RATE_LIMITED; a fixed code constant as in the AI wording route, flagged for the owner);
 *   6. the per-instance daily minute reservation (MINUTES_EXHAUSTED; not a spending cap, voice-minute-ledger.ts);
 *   7. the signing-secret read (missing or invalid: the reservation is released, VOICE_DISABLED);
 *   8. the signature over a random user id (no patient identity), for the configured lifetime; a failed signature releases the
 *      reservation and issues nothing.
 * The secret and the passcode are never echoed or logged. Responses are `no-store` and `nosniff`.
 *
 * Review I-5: `GET` on the same route is the credential-free availability probe the Tell JagaOn screen calls before its disclosure. It
 * answers `{ available }` only: true exactly when the switch is on and the configuration is fully valid (the same parse as step 2). It
 * reads no passcode and no secret, reserves nothing and signs nothing; a request the browser marks cross-site gets false
 * (voiceProbeSiteAllowed); it has its own per-instance window with the same limit as step 5 (429, false). Any other method is 405.
 *
 * Web Speech (owner-approved scope 2026-10-11; draft, pending owner review): when voice is available the probe also lists the enabled
 * providers, `{ available: true, providers: ["TRTC" | "WEB_SPEECH", ...] }` in the deployment's order (no credential, no other value);
 * when it is not, the answer stays `{ available: false }`. Step 2 refuses VOICE_DISABLED when `trtc` is not an enabled provider, so a
 * Web Speech-only deployment issues no Tencent credential and needs no TRTC value. The Web Speech passcode check is its own route
 * (`/api/voice/access`), which reuses the throttle and bucket helpers exported below.
 */
export const VOICE_USERSIG_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });

/**
 * Owner decision #1 (2026-10-09): at most 5 FAILED passcode attempts per 15 minutes per client bucket; the next attempt is refused
 * RATE_LIMITED before the passcode is compared (no minute reservation, no secret read, no provider call; manual entry stays available
 * in the app). BEST-EFFORT, PER INSTANCE, IN MEMORY, NOT DISTRIBUTED: it resets on a cold start and does not span instances.
 * Bucket: the Vercel platform client address (`x-real-ip`, a single valid IPv4/IPv6 literal) ONLY when the deployment sets
 * `JAGAON_TRUST_VERCEL_CLIENT_IP=on` (off by default); otherwise, or when the header is missing or invalid, one shared bucket. People
 * behind one public address share a bucket. The bucket map is bounded (oldest bucket evicted).
 */
export const VOICE_PASSCODE_THROTTLE = Object.freeze({ maxFailures: 5, windowMs: 15 * 60_000, maxBuckets: 1_000 });
const SHARED_BUCKET = "shared";

export type VoiceUserSigSigner = (input: Readonly<{ sdkAppId: number; secretKey: string; userId: string; expireSeconds: number }>) => string;

export type VoiceUserSigHandlerOptions = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  signer: VoiceUserSigSigner;
  now?: () => Date;
  random?: (byteLength: number) => Uint8Array;
  rateLimit?: Readonly<{ maxRequests: number; windowMs: number }>;
  passcodeThrottle?: Readonly<{ maxFailures: number; windowMs: number; maxBuckets: number }>;
  ledger?: VoiceMinuteLedger;
  /** Tencent build-time exclusion: default the inlined build constant (tests inject it). */
  build?: VoiceConfigBuildOptions;
}>;

/** The throttle bucket: the validated Vercel platform client address when trusted, else the shared bucket. */
export function clientBucket(config: Extract<VoiceUserSigConfig, { voiceEnabled: true }>, headers: Headers): string {
  if (!config.trustVercelClientIp) return SHARED_BUCKET;
  const address = headers.get("x-real-ip");
  return address !== null && address.length <= 45 && isIP(address) !== 0 ? `ip:${address}` : SHARED_BUCKET;
}

function reply(body: VoiceUserSigResponse | VoiceAvailabilityResponse, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
const invalid = (status: number) => reply({ kind: "FAILED", reason: "PAYLOAD_INVALID" }, status);
const refused = (reason: VoiceUserSigRefusalReason, status = 403) => reply({ kind: "REFUSED", reason }, status);

/**
 * Owner decision #1's failed-passcode throttle (semantics above), one instance per handler: `blocked` before the passcode is compared,
 * `recordFailure` after a wrong one. Shared by the credential route and the Web Speech access route (each its own instance).
 */
export function createPasscodeThrottle(throttle: Readonly<{ maxFailures: number; windowMs: number; maxBuckets: number }>) {
  const failures = new Map<string, number[]>();
  const recentFailures = (bucket: string, at: number): number[] => (failures.get(bucket) ?? []).filter((time) => time > at - throttle.windowMs);
  return Object.freeze({
    blocked: (bucket: string, at: number): boolean => recentFailures(bucket, at).length >= throttle.maxFailures,
    recordFailure(bucket: string, at: number): void {
      const recent = [...recentFailures(bucket, at), at].slice(-throttle.maxFailures);
      failures.delete(bucket);
      failures.set(bucket, recent);
      while (failures.size > throttle.maxBuckets) failures.delete(failures.keys().next().value as string);
    },
  });
}

/** Reads at most `limit` bytes of UTF-8; null when the body is longer or not valid UTF-8. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function createVoiceUserSigHandler(options: VoiceUserSigHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? ((byteLength: number) => new Uint8Array(randomBytes(byteLength)));
  const limit = options.rateLimit ?? VOICE_USERSIG_RATE_LIMIT;
  const throttle = createPasscodeThrottle(options.passcodeThrottle ?? VOICE_PASSCODE_THROTTLE);
  const admitted: number[] = [];
  const probed: number[] = [];
  // Parsed once, when the first request passes the request checks (the deployment environment does not change while an instance runs).
  let config: VoiceUserSigConfig | null = null;
  let instanceLedger: VoiceMinuteLedger | null = null;
  const ledgerFor = (dailyMinutesLimit: number): VoiceMinuteLedger => options.ledger ?? (instanceLedger ??= new InMemoryDailyMinuteLedger({ dailyMinutesLimit }));

  async function release(ledger: VoiceMinuteLedger, token: VoiceMinuteReservation): Promise<void> {
    try {
      await ledger.release(token);
    } catch {
      // The reservation stays held: it only over-counts.
    }
  }

  return async function handle(request: Request): Promise<Response> {
    // Review I-5: the availability probe (no body read, no passcode, no secret, no reservation).
    if (request.method === "GET") {
      const at = now().getTime();
      while (probed.length > 0 && probed[0]! <= at - limit.windowMs) probed.shift();
      if (probed.length >= limit.maxRequests) return reply({ available: false }, 429);
      probed.push(at);
      if (!voiceProbeSiteAllowed(request.headers)) return reply({ available: false }, 200);
      const parsed = (config ??= parseVoiceUserSigConfig(options.environment, options.build));
      return reply(parsed.voiceEnabled ? { available: true, providers: [...parsed.providers] } : { available: false }, 200);
    }
    // 1. Request checks.
    if (request.method !== "POST") return invalid(405);
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return invalid(415);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > VOICE_USERSIG_MAX_BODY_BYTES) return invalid(413);
    let text: string | null;
    try {
      text = await readLimited(request.body, VOICE_USERSIG_MAX_BODY_BYTES);
    } catch {
      return invalid(400);
    }
    if (text === null) return invalid(413);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return invalid(400);
    }
    if (!voiceUserSigRequestSchema.safeParse(value).success) return invalid(400);

    // 2-4. Switch and configuration, origin, passcode.
    const deployment = (config ??= parseVoiceUserSigConfig(options.environment, options.build));
    if (!deployment.voiceEnabled || !deployment.trtcEnabled) return refused("VOICE_DISABLED");
    if (!voiceOriginAllowed(deployment, request.headers)) return refused("ORIGIN_REJECTED");
    const at = now().getTime();
    const bucket = clientBucket(deployment, request.headers);
    if (throttle.blocked(bucket, at)) return refused("RATE_LIMITED", 429);
    if (!voiceAccessGranted(deployment, request.headers)) {
      throttle.recordFailure(bucket, at);
      return refused("ACCESS_DENIED");
    }

    // 5. Per-instance request rate.
    while (admitted.length > 0 && admitted[0]! <= at - limit.windowMs) admitted.shift();
    if (admitted.length >= limit.maxRequests) return refused("RATE_LIMITED", 429);
    admitted.push(at);

    // 6. Minute reservation (fail closed on any ledger error).
    let ledger: VoiceMinuteLedger;
    let token: VoiceMinuteReservation;
    try {
      ledger = ledgerFor(deployment.dailyMinutesLimit);
      const reserved = await ledger.reserve(voiceSessionMinutes(deployment.maxSessionSeconds), now());
      if (reserved?.kind === "REFUSED" && reserved.reason === "MINUTES_EXHAUSTED") return refused("MINUTES_EXHAUSTED", 429);
      if (reserved?.kind !== "RESERVED" || typeof reserved.token !== "object" || reserved.token === null) return refused("VOICE_DISABLED", 503);
      token = reserved.token;
    } catch {
      return refused("VOICE_DISABLED", 503);
    }

    // 7. The signing secret, read last.
    const secretKey = readTrtcSecretKey(options.environment);
    if (secretKey === null) {
      await release(ledger, token);
      return refused("VOICE_DISABLED", 503);
    }

    // 8. Sign over a random per-session user id; a random room id (no patient identity).
    const userId = `jv_${base64url(random(16))}`;
    const roomId = `jr_${base64url(random(24))}`;
    let userSig = "";
    try {
      if (VOICE_USER_ID_PATTERN.test(userId) && VOICE_ROOM_ID_PATTERN.test(roomId)) userSig = options.signer({ sdkAppId: deployment.sdkAppId, secretKey, userId, expireSeconds: deployment.userSigTtlSeconds });
    } catch {
      userSig = "";
    }
    if (typeof userSig !== "string" || !VOICE_USERSIG_PATTERN.test(userSig)) {
      await release(ledger, token);
      return refused("VOICE_DISABLED", 503);
    }
    const expiresAt = new Date(at + deployment.userSigTtlSeconds * 1_000).toISOString();
    return reply({ kind: "ISSUED", sdkAppId: deployment.sdkAppId, userId, userSig, roomId, expiresAt, maxSessionSeconds: deployment.maxSessionSeconds }, 200);
  };
}
