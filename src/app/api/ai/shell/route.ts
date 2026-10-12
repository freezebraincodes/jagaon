import { createAiShellHandler } from "./ai-shell-handler";

/**
 * The value-blind shell route (Packet 11C Addendum B, Task B2a). The provider credential is a server-only secret, read by the handler only
 * after every request check and never returned. While the activation manifest is deterministic-only (shipped), every request answers with
 * a closed reason and no provider call.
 */
export const dynamic = "force-dynamic";

const handle = createAiShellHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/**
 * Owner decision 2026-10-12 (optional passcodes): the passcode probe, `{ passcodeRequired }` only (no credential read, no provider call;
 * see the handler).
 */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
