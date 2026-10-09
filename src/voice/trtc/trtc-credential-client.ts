import { VOICE_ACCESS_HEADER, VOICE_USERSIG_ROUTE_PATH, voiceAvailabilityResponseSchema, voiceUserSigResponseSchema } from "./trtc-usersig-contract";
import type { TrtcCredentialRequest, TrtcCredentialResult } from "./trtc-transcriber-adapter";

/**
 * Packet 13 slice (P13S, S7): the browser's same-origin calls to `/api/voice/usersig` (the only network calls of the voice stream):
 * the credential POST below and the credential-free availability GET (`fetchVoiceAvailability`, review I-5), through one fetch site. It sends `{}` with the demo passcode header, `cache: "no-store"`, redirects refused and the caller's abort signal, then parses
 * the answer with the shared contract and maps it to closed results: ISSUED (the credential for the adapter), REFUSED (the route's
 * closed reason) or FAILED NETWORK_FAILURE (anything else). No passcode: nothing is sent. The passcode is read from memory (the getter)
 * on each request and never stored, logged or persisted here.
 */
export type VoiceCredentialFetcher = (input: string, init: RequestInit) => Promise<Response>;

const MAX_RESPONSE_CHARS = 8_192;
const NETWORK_FAILURE: TrtcCredentialResult = Object.freeze({ kind: "FAILED", reason: "NETWORK_FAILURE" });

const defaultFetcher: VoiceCredentialFetcher = (input, init) => fetch(input, init);

/**
 * Review I-5: the credential-free availability probe — one same-origin GET (no passcode, no body, `no-store`, redirects refused). True
 * only for a 200 answer that is exactly `{ "available": true }`; anything else (network error, abort, other status, other body) is
 * false, so the screen fails closed to "unavailable" with manual entry.
 */
export async function fetchVoiceAvailability(options: Readonly<{ fetcher?: VoiceCredentialFetcher; signal?: AbortSignal }> = {}): Promise<boolean> {
  try {
    const response = await (options.fetcher ?? defaultFetcher)(VOICE_USERSIG_ROUTE_PATH, { method: "GET", cache: "no-store", redirect: "error", ...(options.signal ? { signal: options.signal } : {}) });
    if (response.status !== 200) return false;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return false;
    const parsed = voiceAvailabilityResponseSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.available === true;
  } catch {
    return false;
  }
}

export function createTrtcCredentialClient(options: Readonly<{ accessPasscode: () => string | null; fetcher?: VoiceCredentialFetcher }>): TrtcCredentialRequest {
  const fetcher: VoiceCredentialFetcher = options.fetcher ?? defaultFetcher;
  return async function requestCredential(signal: AbortSignal): Promise<TrtcCredentialResult> {
    let passcode: string | null = null;
    try {
      passcode = options.accessPasscode();
    } catch {
      passcode = null;
    }
    if (typeof passcode !== "string" || passcode.length === 0) return Object.freeze({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    if (signal.aborted) return NETWORK_FAILURE;
    let parsed: ReturnType<typeof voiceUserSigResponseSchema.safeParse>;
    let status: number;
    try {
      const response = await fetcher(VOICE_USERSIG_ROUTE_PATH, { method: "POST", headers: { "content-type": "application/json", [VOICE_ACCESS_HEADER]: passcode }, body: "{}", signal, cache: "no-store", redirect: "error" });
      status = response.status;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) return NETWORK_FAILURE;
      parsed = voiceUserSigResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return NETWORK_FAILURE;
    }
    if (!parsed.success) return NETWORK_FAILURE;
    const body = parsed.data;
    if (body.kind === "REFUSED") return Object.freeze({ kind: "REFUSED", reason: body.reason });
    if (body.kind === "FAILED") return Object.freeze({ kind: "REFUSED", reason: "PAYLOAD_INVALID" });
    if (status !== 200) return NETWORK_FAILURE;
    return Object.freeze({
      kind: "ISSUED",
      credential: Object.freeze({ sdkAppId: body.sdkAppId, userId: body.userId, userSig: body.userSig, roomId: body.roomId, maxSessionSeconds: body.maxSessionSeconds }),
    });
  };
}
