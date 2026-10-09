import { createAiRemoteUseDecisions } from "@/application/ai/browser-shell-client";
import type { ExtractionFactKind } from "@/domain/transcript-extraction/transcript-extraction-contract";
import type { VoiceCandidate, VoiceLanguage } from "@/domain/voice/voice-contracts";
import { createTranscriptExtractionClient } from "./transcript-extraction-client";

/**
 * Packet 13 (P13X): the voice review's optional remote-extraction function (`TellJagaOnScreen`'s `remoteExtraction` prop), built on the
 * transcript-extraction client. Browser-safe; no credential, prompt or provider code.
 *
 * The screen shows its OWN per-request DeepSeek disclosure and calls this function only after the person accepted it, for that one
 * request. So calling the function IS that request's decision: each call binds one acceptance, through the shared Packet 11C C3
 * per-request decision machinery (`createAiRemoteUseDecisions().run`), to the screen's AbortSignal for exactly that call. It ends when
 * the call settles or the signal aborts, is never stored and never covers another call (a fresh registry per call).
 *
 * Mapping of the client's result: EXTRACTED → CANDIDATES (validated, mapped `VoiceCandidate`s); WITHHELD (the voice slice's pre-request
 * gate; nothing sent) → WITHHELD; any FALLBACK (declined or aborted, passcode missing, refused, failed, rejected, unmappable, network)
 * → UNAVAILABLE, and the screen keeps its local result. Nothing here logs or keeps the transcript.
 */
export type VoiceRemoteExtractionResult =
  | Readonly<{ kind: "CANDIDATES"; candidates: readonly VoiceCandidate[] }>
  | Readonly<{ kind: "UNAVAILABLE" | "WITHHELD" }>;

/** Structurally the screen's `VoiceRemoteExtraction` prop (declared here so application code does not import a component). */
export type VoiceRemoteExtractionFunction = (transcript: string, language: VoiceLanguage, signal: AbortSignal) => Promise<VoiceRemoteExtractionResult>;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const ALL_FACT_KINDS: readonly ExtractionFactKind[] = Object.freeze(["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"]);
const UNAVAILABLE: VoiceRemoteExtractionResult = Object.freeze({ kind: "UNAVAILABLE" });
const WITHHELD: VoiceRemoteExtractionResult = Object.freeze({ kind: "WITHHELD" });

export function createVoiceRemoteExtraction(options: Readonly<{ passcode: () => string | null; fetcher?: Fetcher }>): VoiceRemoteExtractionFunction {
  return async function remoteExtraction(transcript, language, signal) {
    // One registry and one client per call: the decision exists only for this call's signal.
    const decisions = createAiRemoteUseDecisions();
    const client = createTranscriptExtractionClient({ disclosure: decisions.disclosure, passcode: options.passcode, fetcher: options.fetcher });
    const locale = language === "zh" ? "zh-SG" : "en-SG";
    try {
      // The screen's acceptance of its disclosure for this one request.
      const result = await decisions.run("ACCEPTED", signal, (token) => client.extract({ transcript, locale, allowedFactKinds: ALL_FACT_KINDS, signal: token ?? signal }));
      if (result.kind === "EXTRACTED") return Object.freeze({ kind: "CANDIDATES" as const, candidates: result.candidates });
      return result.kind === "WITHHELD" ? WITHHELD : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  };
}
