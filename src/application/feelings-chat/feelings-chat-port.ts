import type { FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import type { ValidatedFeelingsChatReply } from "@/domain/feelings-chat/feelings-chat-validator";
import type { FeelingsChatUnavailableReason } from "./feelings-chat-route-contract";

/**
 * Tell JagaOn understands more: the feelings-chat port shared by the browser client, the fake port and the chat dialog. No network,
 * prompt, provider or storage code: the dialog depends on this module only, never on the network client.
 */
export type FeelingsChatFallbackReason = FeelingsChatUnavailableReason | "REQUEST_INVALID" | "RESPONSE_INVALID" | "REJECTED_BY_SERVER" | "REJECTED_ON_DEVICE";

export type FeelingsChatTurnResult =
  | Readonly<{ source: "AI_VALIDATED"; reply: ValidatedFeelingsChatReply }>
  | Readonly<{ source: "REVIEWED_BANK"; reply: ValidatedFeelingsChatReply; reason: FeelingsChatFallbackReason }>;

/** The port the chat dialog uses (the real client, or the fake port for tests and the offline demo). */
export type FeelingsChatPort = Readonly<{ nextTurn: (request: FeelingsChatRequest, signal?: AbortSignal) => Promise<FeelingsChatTurnResult> }>;

export type FeelingsChatInterventionCounts = Readonly<{
  /** Turns asked of the port. */
  requests: number;
  /** Replies shown as written by the AI (passed both validators). */
  aiAccepted: number;
  /** Replies the server's validator rejected. */
  rejectedByServer: number;
  /** Replies the server accepted (or a fake produced) that the device's validator rejected. */
  rejectedOnDevice: number;
  /** The AI was off, unreachable, out of credit, rate limited, timed out, or answered in an unexpected shape. */
  unavailable: number;
  /** rejectedByServer + rejectedOnDevice: how often the rules stepped in. */
  rulesSteppedIn: number;
}>;

type Counts = { -readonly [K in keyof FeelingsChatInterventionCounts]: number };

/** In-memory intervention counts: numbers only, never text; reset with the page. */
export function createInterventionCounter() {
  const counts: Counts = { requests: 0, aiAccepted: 0, rejectedByServer: 0, rejectedOnDevice: 0, unavailable: 0, rulesSteppedIn: 0 };
  return Object.freeze({
    record(result: FeelingsChatTurnResult): FeelingsChatTurnResult {
      counts.requests += 1;
      if (result.source === "AI_VALIDATED") counts.aiAccepted += 1;
      else if (result.reason === "REJECTED_BY_SERVER") counts.rejectedByServer += 1;
      else if (result.reason === "REJECTED_ON_DEVICE") counts.rejectedOnDevice += 1;
      else counts.unavailable += 1;
      counts.rulesSteppedIn = counts.rejectedByServer + counts.rejectedOnDevice;
      return result;
    },
    snapshot: (): FeelingsChatInterventionCounts => Object.freeze({ ...counts }),
  });
}

/** Re-exported so a port implementation needs only this module. */
export type { FeelingsChatRequest };
