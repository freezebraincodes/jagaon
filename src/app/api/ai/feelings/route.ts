import { createFeelingsChatHandler } from "./feelings-chat-handler";

/**
 * Tell JagaOn understands more (design §3.8): the bounded DeepSeek feelings-chat route (FEELINGS_CHAT_TURN). The provider credential is a
 * server-only secret, read by the handler only after every request check, both switches, the origin and access checks and the spend
 * reservation. Off unless JAGAON_REMOTE_AI and JAGAON_AI_FEELINGS_CHAT are both exactly "on" and its own daily spend limit is set.
 */
export const dynamic = "force-dynamic";

const handle = createFeelingsChatHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
