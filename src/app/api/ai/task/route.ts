import { createAiTaskHandler } from "./ai-task-handler";

/**
 * Same-origin AI task proxy (Packet 11B). `KIE_API_KEY` is a server-only
 * secret read here and never returned. Without it, or while the activation
 * manifest is deterministic-only and no bundle pins an approved model (all of
 * 11B), every request answers with a closed fallback reason.
 */
export const dynamic = "force-dynamic";

const handle = createAiTaskHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
