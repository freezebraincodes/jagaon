import { VOICE_USERSIG_MAX_BODY_BYTES, voiceUserSigRequestSchema, type VoiceAccessResponse, type VoiceUserSigRefusalReason } from "@/voice/trtc/trtc-usersig-contract";
import { parseVoiceUserSigConfig, voiceAccessGranted, voiceOriginAllowed, type VoiceConfigBuildOptions, type VoiceUserSigConfig } from "../usersig/voice-usersig-config";
import { clientBucket, createPasscodeThrottle, readLimited, VOICE_PASSCODE_THROTTLE, VOICE_USERSIG_RATE_LIMIT } from "../usersig/voice-usersig-handler";

/**
 * Web Speech (owner-approved scope 2026-10-11, coordinator ruling W-3, reversible; draft, pending owner review): `POST /api/voice/access`,
 * the demo-passcode check before a Web Speech session. Server-only. It issues NO credential, reads NO TRTC value or secret, reserves no
 * minutes and calls no provider: the browser's own speech recognition needs none. It reuses the credential route's pieces and order:
 *   1. method, content type, body cap and strict JSON `{}` (405 / 415 / 413 / 400, FAILED PAYLOAD_INVALID);
 *   2. the switch, a valid configuration AND `webspeech` among the enabled providers (VOICE_DISABLED);
 *   3. Origin in the configured list AND `Sec-Fetch-Site: same-origin` (ORIGIN_REJECTED);
 *   4. the failed-passcode throttle (RATE_LIMITED; owner decision #1's semantics, this route's own per-instance buckets), then the
 *      demo passcode, constant-time (ACCESS_DENIED);
 *   5. the per-instance request rate (RATE_LIMITED);
 *   6. GRANTED with the server's maximum session length (`JAGAON_VOICE_MAX_SESSION_SECONDS`; the client controller enforces it).
 * The passcode is never echoed or logged. Responses are `no-store` and `nosniff`.
 */
export type VoiceAccessHandlerOptions = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  rateLimit?: Readonly<{ maxRequests: number; windowMs: number }>;
  passcodeThrottle?: Readonly<{ maxFailures: number; windowMs: number; maxBuckets: number }>;
  /** Tencent build-time exclusion: default the inlined build constant (tests inject it). */
  build?: VoiceConfigBuildOptions;
}>;

function reply(body: VoiceAccessResponse, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
const invalid = (status: number) => reply({ kind: "FAILED", reason: "PAYLOAD_INVALID" }, status);
const refused = (reason: VoiceUserSigRefusalReason, status = 403) => reply({ kind: "REFUSED", reason }, status);

export function createVoiceAccessHandler(options: VoiceAccessHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? VOICE_USERSIG_RATE_LIMIT;
  const throttle = createPasscodeThrottle(options.passcodeThrottle ?? VOICE_PASSCODE_THROTTLE);
  const admitted: number[] = [];
  let config: VoiceUserSigConfig | null = null;

  return async function handle(request: Request): Promise<Response> {
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

    // 2-4. Switch, configuration and provider; origin; passcode.
    const deployment = (config ??= parseVoiceUserSigConfig(options.environment, options.build));
    if (!deployment.voiceEnabled || !deployment.providers.includes("WEB_SPEECH")) return refused("VOICE_DISABLED");
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

    // 6. Access granted: no credential, only the server's maximum session length.
    return reply({ kind: "GRANTED", maxSessionSeconds: deployment.maxSessionSeconds }, 200);
  };
}
