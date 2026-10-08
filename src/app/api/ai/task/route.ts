import { createAiTaskHandler } from "./ai-task-handler";

/**
 * RETIRED legacy AI task route (Packet 11C Addendum B, Task B2a). It refuses every request with a closed reason and reads no secret or
 * configuration; the value-blind successor is POST /api/ai/shell.
 */
export const dynamic = "force-dynamic";

const handle = createAiTaskHandler();

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
