import { createVoiceUserSigHandler } from "./voice-usersig-handler";
import { signTrtcUserSig } from "./voice-usersig-signer";

/**
 * Packet 13 slice (P13S, S7): POST /api/voice/usersig (and GET, the availability probe), the short-lived TRTC credential for one voice session (Node runtime, the default
 * for route handlers; never edge). The only environment read of the voice stream. Every check and the secret read live in the handler.
 */
export const dynamic = "force-dynamic";

const handle = createVoiceUserSigHandler({ environment: process.env, signer: signTrtcUserSig });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/** Review I-5: the credential-free availability probe (`{ available }` only; see the handler). */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
