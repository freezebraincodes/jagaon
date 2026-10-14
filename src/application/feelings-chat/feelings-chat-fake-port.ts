import { validateFeelingsChatReply } from "@/domain/feelings-chat/feelings-chat-validator";
import { feelingsChatBankReply } from "@/domain/feelings-chat/feelings-chat-bank";
import type { FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import { createInterventionCounter, type FeelingsChatFallbackReason, type FeelingsChatPort, type FeelingsChatTurnResult } from "./feelings-chat-port";

/**
 * Tell JagaOn understands more: a pure, network-free feelings-chat port for tests and the offline demo. Each scripted step is either a
 * model-style candidate reply (run through the SAME validator as the real client, so a scripted bad reply is rejected and replaced from
 * the bank, exactly as in production), a fallback reason (the AI "unavailable"), or a function of the request. When the script runs
 * out, every turn falls back to the bank with UPSTREAM_ERROR. It records the requests it was asked (in memory, for assertions).
 */
export type FakeFeelingsChatStep = Readonly<{ candidate: unknown }> | Readonly<{ unavailable: FeelingsChatFallbackReason }> | ((request: FeelingsChatRequest) => FeelingsChatTurnResult);

export function createFakeFeelingsChatPort(script: readonly FakeFeelingsChatStep[] = []) {
  const requests: FeelingsChatRequest[] = [];
  const counter = createInterventionCounter();
  let next = 0;
  const port: FeelingsChatPort = Object.freeze({
    nextTurn: async (request: FeelingsChatRequest): Promise<FeelingsChatTurnResult> => {
      requests.push(request);
      const step = script[next];
      next += 1;
      const fallback = (reason: FeelingsChatFallbackReason): FeelingsChatTurnResult => Object.freeze({ source: "REVIEWED_BANK" as const, reply: feelingsChatBankReply(request), reason });
      if (step === undefined) return counter.record(fallback("UPSTREAM_ERROR"));
      if (typeof step === "function") return counter.record(step(request));
      if ("unavailable" in step) return counter.record(fallback(step.unavailable));
      const validation = validateFeelingsChatReply(step.candidate, request);
      if (!validation.ok) return counter.record(fallback("REJECTED_ON_DEVICE"));
      const dropped = validation.doctorQuestionDropped;
      return counter.record(Object.freeze({ source: "AI_VALIDATED" as const, reply: validation.value, ...(dropped ? { doctorQuestionDropped: dropped } : {}) }));
    },
  });
  return Object.freeze({ ...port, requests: () => [...requests], interventions: () => counter.snapshot() });
}
