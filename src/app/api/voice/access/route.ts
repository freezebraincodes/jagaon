import { createVoiceAccessHandler } from "./voice-access-handler";

/**
 * Web Speech (owner-approved scope 2026-10-11, coordinator ruling W-3; draft): POST /api/voice/access, the demo-passcode check before a
 * Web Speech session (Node runtime; never edge). No credential is issued and no provider is called. The only environment read of this
 * route; every check lives in the handler.
 */
export const dynamic = "force-dynamic";

const handle = createVoiceAccessHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
