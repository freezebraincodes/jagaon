import { AI_SHELL_ACCESS_HEADER } from "@/application/ai/ai-shell-route-contract";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { feelingsChatBankReply } from "@/domain/feelings-chat/feelings-chat-bank";
import { feelingsChatRequestSchema, type FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import { validateFeelingsChatReply } from "@/domain/feelings-chat/feelings-chat-validator";
import { createInterventionCounter, type FeelingsChatFallbackReason, type FeelingsChatTurnResult } from "./feelings-chat-port";
import { FEELINGS_CHAT_ROUTE_PATH, feelingsChatRouteResponseSchema } from "./feelings-chat-route-contract";

/**
 * Tell JagaOn understands more (design §3.3, steps [3]–[6]): the browser client of POST /api/ai/feelings. Browser-safe; no credential,
 * prompt or provider code.
 *
 * Per turn: (1) the strict request schema (nothing is sent when it fails); (2) one same-origin POST, no retry, with the demo passcode
 * header when the caller holds one; (3) the response schema; (4) an OK reply is validated AGAIN on the device with the same rules
 * (feelings-chat-validator.1). Every other outcome falls back to the reviewed bank (`feelingsChatBankReply`: the turn's bank question,
 * or at turn 3 a local wrap-up from her first message, no doctor question, no theme), with a closed reason. A request that fails the
 * schema is never sent.
 * The client never logs or stores chat text. It counts interventions (numbers only, in memory) for the demo's "how often the rules
 * stepped in" metric.
 */
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
const MAX_RESPONSE_CHARS = 16_384;
export const FEELINGS_CHAT_CLIENT_TIMEOUT_MS = 20_000;

export type FeelingsChatClientOptions = Readonly<{
  /** Defaults to the global fetch (same-origin POST to the relative route path only). */
  fetcher?: Fetcher;
  /** The demo passcode the person entered for this session (memory only), or null. */
  passcode?: () => string | null;
  timeoutMs?: number;
}>;

export function createFeelingsChatClient(options: FeelingsChatClientOptions = {}) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? FEELINGS_CHAT_CLIENT_TIMEOUT_MS;
  const counter = createInterventionCounter();

  async function attempt(input: FeelingsChatRequest, signal: AbortSignal | undefined): Promise<FeelingsChatTurnResult> {
    const fallback = (reason: FeelingsChatFallbackReason, request: Pick<FeelingsChatRequest, "turn" | "maxTurns" | "messages"> = input): FeelingsChatTurnResult =>
      Object.freeze({ source: "REVIEWED_BANK" as const, reply: feelingsChatBankReply(request), reason });
    const parsed = feelingsChatRequestSchema.safeParse(input);
    if (!parsed.success) return fallback("REQUEST_INVALID", { turn: typeof input?.turn === "number" ? input.turn : 1, maxTurns: 3, messages: Array.isArray(input?.messages) ? input.messages : [] });
    const request = parsed.data;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      if (signal?.aborted) return fallback("CANCELLED");
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      let passcode: string | null = null;
      try {
        passcode = options.passcode?.() ?? null;
      } catch {
        passcode = null;
      }
      if (passcode) headers[AI_SHELL_ACCESS_HEADER] = passcode;
      let response: Response;
      try {
        response = await fetcher(FEELINGS_CHAT_ROUTE_PATH, { method: "POST", cache: "no-store", credentials: "same-origin", headers, body: JSON.stringify(request), signal: controller.signal });
      } catch {
        return fallback(timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "OFFLINE");
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) return fallback("RESPONSE_INVALID");
        body = toPlainData(parseStrictJson(text, { maxDepth: 4, maxLength: MAX_RESPONSE_CHARS }));
      } catch {
        return fallback(timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "RESPONSE_INVALID");
      }
      const route = feelingsChatRouteResponseSchema.safeParse(body);
      if (!route.success) return fallback("RESPONSE_INVALID");
      if (route.data.kind === "UNAVAILABLE") return fallback(route.data.reason);
      if (route.data.kind === "REJECTED") return fallback("REJECTED_BY_SERVER");
      // The device validates the server-accepted reply again before anything is shown.
      const validation = validateFeelingsChatReply(route.data.reply, request);
      if (!validation.ok) return fallback("REJECTED_ON_DEVICE");
      return Object.freeze({ source: "AI_VALIDATED" as const, reply: validation.value });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return Object.freeze({
    nextTurn: async (request: FeelingsChatRequest, signal?: AbortSignal): Promise<FeelingsChatTurnResult> => counter.record(await attempt(request, signal)),
    /** Numbers only, in memory (never text): for the demo's "how often the rules stepped in" metric. */
    interventions: () => counter.snapshot(),
  });
}
