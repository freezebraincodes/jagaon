import { createTranscriptExtractionHandler } from "./transcript-extraction-handler";

/**
 * Packet 13 (P13X): the bounded DeepSeek transcript-extraction route (EXTRACT_VOICE_FACTS). The provider credential is a server-only
 * secret, read by the handler only after every request check, switch, access check, activation, qualification and spend reservation.
 * Shipped: the task is not activated and its contract is not qualified, so every request is refused before any credential read.
 */
export const dynamic = "force-dynamic";

const handle = createTranscriptExtractionHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
