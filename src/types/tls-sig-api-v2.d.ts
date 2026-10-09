/**
 * Packet 13 slice (P13S, S6b): the minimal declaration of `tls-sig-api-v2@1.0.2` (CommonJS, `exports.Api`; the package ships no types).
 * Only the members JagaOn uses. Server-only: imported by `src/app/api/voice/usersig/voice-usersig-signer.ts` alone.
 */
declare module "tls-sig-api-v2" {
  export class Api {
    constructor(sdkappid: number, key: string);
    /** Returns the UserSig for `userid`, valid for `expire` seconds from `Date.now()`. */
    genSig(userid: string, expire: number): string;
  }
}
