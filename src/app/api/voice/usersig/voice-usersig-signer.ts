import { Api } from "tls-sig-api-v2";
import { VOICE_USER_ID_PATTERN } from "@/voice/trtc/trtc-usersig-contract";
import { VOICE_USERSIG_BOUNDS } from "./voice-usersig-config";
import type { VoiceUserSigSigner } from "./voice-usersig-handler";

/**
 * Packet 13 slice (P13S, S6b): the server-only UserSig signer over `tls-sig-api-v2@1.0.2` (owner decision 4). The ONLY module that
 * imports the library. The library does no input validation, so this wrapper checks every input first: the user id (1 to 32 bytes of
 * `[A-Za-z0-9_-]`), the lifetime against the configured TTL bounds, an integer application id of at most 10 digits and a non-empty
 * secret. An invalid input throws a fixed message that never contains a value. The library reads `Date.now()` for `TLS.time`. The
 * generated UserSig is returned to the handler only; nothing is logged.
 */
export const signTrtcUserSig: VoiceUserSigSigner = ({ sdkAppId, secretKey, userId, expireSeconds }) => {
  const { min, max } = VOICE_USERSIG_BOUNDS.userSigTtlSeconds;
  const valid =
    Number.isSafeInteger(sdkAppId) &&
    sdkAppId > 0 &&
    sdkAppId <= 9_999_999_999 &&
    typeof userId === "string" &&
    VOICE_USER_ID_PATTERN.test(userId) &&
    Number.isSafeInteger(expireSeconds) &&
    expireSeconds >= min &&
    expireSeconds <= max &&
    typeof secretKey === "string" &&
    secretKey.length > 0;
  if (!valid) throw new TypeError("VOICE_SIGNER_INPUT_INVALID");
  return new Api(sdkAppId, secretKey).genSig(userId, expireSeconds);
};
