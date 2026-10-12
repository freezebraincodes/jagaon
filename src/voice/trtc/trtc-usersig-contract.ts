import { z } from "zod";

/**
 * Packet 13 slice (P13S, S6a): the request and response contract of `POST /api/voice/usersig`, shared by the server route and the browser
 * credential client. It imports no SDK and no server module: it is safe in both graphs.
 *
 * - Request: exactly `{}` (strict), JSON, at most VOICE_USERSIG_MAX_BODY_BYTES bytes, with the demo passcode in the
 *   `x-jagaon-demo-passcode` header (its own constant, the same literal as the AI wording route's header; the VALUES are configured
 *   separately, owner decision "Voice access" 2026-10-09). Owner decision 2026-10-12 (optional passcodes): when the deployment
 *   configures no passcode, the header is not sent (the probe says `passcodeRequired: false`).
 * - ISSUED: the TRTC application id, a random per-session user id and room id (no patient identity), the short-lived UserSig, its expiry
 *   (ISO instant) and the server's maximum session length. The secret key is never part of any response.
 * - REFUSED: one closed reason, issued nothing. FAILED: the request itself was malformed.
 */
export const VOICE_USERSIG_CONTRACT_VERSION = "voice-usersig-contract.13s.1";
export const VOICE_USERSIG_ROUTE_PATH = "/api/voice/usersig";
export const VOICE_ACCESS_HEADER = "x-jagaon-demo-passcode";
export const VOICE_USERSIG_MAX_BODY_BYTES = 256;

export const VOICE_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const VOICE_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A UserSig is base64 with `+/=` escaped as `*-_` (the server signer's documented format). */
export const VOICE_USERSIG_PATTERN = /^[A-Za-z0-9*_-]{1,4096}$/;

export const voiceUserSigRequestSchema = z.object({}).strict();

export const VOICE_USERSIG_REFUSAL_REASONS = ["VOICE_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "RATE_LIMITED", "MINUTES_EXHAUSTED"] as const;
export type VoiceUserSigRefusalReason = (typeof VOICE_USERSIG_REFUSAL_REASONS)[number];

export const voiceUserSigIssuedSchema = z
  .object({
    kind: z.literal("ISSUED"),
    sdkAppId: z.number().int().positive().max(9_999_999_999),
    userId: z.string().regex(VOICE_USER_ID_PATTERN),
    userSig: z.string().regex(VOICE_USERSIG_PATTERN),
    roomId: z.string().regex(VOICE_ROOM_ID_PATTERN),
    expiresAt: z.string().datetime(),
    maxSessionSeconds: z.number().int().min(10).max(900),
  })
  .strict();
export type VoiceUserSigIssued = z.infer<typeof voiceUserSigIssuedSchema>;

export const voiceUserSigResponseSchema = z.discriminatedUnion("kind", [
  voiceUserSigIssuedSchema,
  z.object({ kind: z.literal("REFUSED"), reason: z.enum(VOICE_USERSIG_REFUSAL_REASONS) }).strict(),
  z.object({ kind: z.literal("FAILED"), reason: z.literal("PAYLOAD_INVALID") }).strict(),
]);
export type VoiceUserSigResponse = z.infer<typeof voiceUserSigResponseSchema>;

/**
 * Review I-5 (owner: when voice is off, explain it and offer manual input before anything else): `GET /api/voice/usersig` answers only
 * whether voice is available — the switch is on and the configuration is valid. No passcode, no secret read, nothing else revealed.
 */
export const VOICE_PROBE_PROVIDERS = ["TRTC", "WEB_SPEECH"] as const;
/**
 * Web Speech (owner-approved scope 2026-10-11; draft): when available, the probe also lists the deployment-enabled providers in the
 * deployment's order (`providers`, ids only). An answer without `providers` (voice off) enables nothing.
 */
/**
 * Owner decision 2026-10-12 (optional passcodes): when available, the probe also says whether the demo passcode is required
 * (`passcodeRequired`, a boolean only; never a value). An available answer without it (an older server) counts as required, so the
 * client keeps asking (fail safe).
 */
export const voiceAvailabilityResponseSchema = z
  .object({ available: z.boolean(), providers: z.array(z.enum(VOICE_PROBE_PROVIDERS)).min(1).max(VOICE_PROBE_PROVIDERS.length).optional(), passcodeRequired: z.boolean().optional() })
  .strict();
export type VoiceAvailabilityResponse = z.infer<typeof voiceAvailabilityResponseSchema>;

/**
 * Web Speech (owner-approved scope 2026-10-11, coordinator ruling W-3; draft): `POST /api/voice/access`, the demo-passcode check before a
 * Web Speech session. Request exactly as the credential route (`{}`, JSON, the passcode header, same size cap). GRANTED carries only the
 * server's maximum session length: no credential, no identifier, and no provider is contacted. REFUSED reuses the credential route's
 * closed reasons (never MINUTES_EXHAUSTED: Web Speech reserves no minutes).
 */
export const VOICE_ACCESS_ROUTE_PATH = "/api/voice/access";
export const voiceAccessResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GRANTED"), maxSessionSeconds: z.number().int().min(10).max(900) }).strict(),
  z.object({ kind: z.literal("REFUSED"), reason: z.enum(VOICE_USERSIG_REFUSAL_REASONS) }).strict(),
  z.object({ kind: z.literal("FAILED"), reason: z.literal("PAYLOAD_INVALID") }).strict(),
]);
export type VoiceAccessResponse = z.infer<typeof voiceAccessResponseSchema>;
