import { AI_SHELL_ACCESS_HEADER } from "@/application/ai/ai-shell-route-contract";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import type { AiRemoteUseDisclosure } from "@/application/ai/ai-provider-port";
import {
  TRANSCRIPT_EXTRACTION_CONTRACT_VERSION,
  TRANSCRIPT_EXTRACTION_TASK,
  extractionRequestSchema,
  type ExtractionFactKind,
  type ExtractionRequest,
  type TranscriptExtractionLocale,
} from "@/domain/transcript-extraction/transcript-extraction-contract";
import { validateExtraction } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { gateRemoteTranscriptExtraction, type VoiceRemoteExtractionGate } from "@/domain/voice/voice-remote-extraction-gate";
import type { VoiceCandidate } from "@/domain/voice/voice-contracts";
import { mapToVoiceCandidates } from "./transcript-extraction-mapper";
import { transcriptRedirect } from "./transcript-extraction-redirect";
import { TRANSCRIPT_EXTRACTION_ROUTE_PATH, transcriptExtractionResponseSchema } from "./transcript-extraction-route-contract";

/**
 * Packet 13 (P13X): the browser client of POST /api/ai/transcript. Browser-safe; no credential, prompt or provider code.
 *
 * Per explicit request, in order: (1) the voice slice's frozen pre-request gate `gateRemoteTranscriptExtraction` (redirect content,
 * too long, empty, invalid: the WHOLE transcript is withheld, nothing is sent and no disclosure is asked); (2) this task's stricter
 * request schema; (3) the per-request remote-use disclosure (Packet 11C C3 port: only ACCEPTED proceeds; declined, closed or not
 * accepted send nothing); (4) the demo passcode the person entered, held in memory by the caller (missing: nothing is sent); (5) one
 * same-origin POST with no retry; (6) the response schema; (7) EXTRACTED output is validated AGAIN against this transcript with the
 * same r-rules, then (8) mapped to the frozen `VoiceCandidate` union (voice-contract.13s.3). Every other outcome is FALLBACK with a
 * closed reason: the voice flow then uses the deterministic local extractor. The transcript is never logged or persisted here; `sent` says whether the transcript may have
 * reached the provider (conservative: a network failure counts as sent; a REFUSED or a not-sent FAILED does not).
 */
export type TranscriptExtractionFallbackReason =
  | "REQUEST_INVALID"
  | "REMOTE_USE_DECLINED"
  | "PASSCODE_MISSING"
  | "NETWORK_FAILED"
  | "RESPONSE_INVALID"
  | "REFUSED"
  | "FAILED"
  | "REJECTED_BY_SERVER"
  | "REJECTED_LOCALLY"
  /** The validated output could not be expressed in the voice candidate union (voice-contract.13s.3). */
  | "UNMAPPABLE";

export type TranscriptExtractionClientResult =
  /** The voice slice's pre-request gate withheld the whole transcript: nothing was sent, no disclosure was asked. */
  | Readonly<{ kind: "WITHHELD"; reason: Extract<VoiceRemoteExtractionGate, { kind: "WITHHOLD" }>["reason"] }>
  | Readonly<{ kind: "EXTRACTED"; candidates: readonly VoiceCandidate[]; downgraded: number; costMicroUsd: number | null }>
  | Readonly<{ kind: "FALLBACK"; reason: TranscriptExtractionFallbackReason; detail: string | null; sent: boolean }>;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
/** The largest response read (characters), as browser-shell-client. */
const MAX_RESPONSE_CHARS = 65_536;

export type TranscriptExtractionClientOptions = Readonly<{
  disclosure: AiRemoteUseDisclosure;
  /** The demo passcode the person entered for this session (memory only), or null. */
  passcode: () => string | null;
  fetcher?: Fetcher;
}>;

export function createTranscriptExtractionClient(options: TranscriptExtractionClientOptions) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const fallback = (reason: TranscriptExtractionFallbackReason, sent: boolean, detail: string | null = null): TranscriptExtractionClientResult => Object.freeze({ kind: "FALLBACK" as const, reason, detail, sent });

  return Object.freeze({
    async extract(input: { transcript: string; locale: TranscriptExtractionLocale; allowedFactKinds: readonly ExtractionFactKind[]; signal: AbortSignal }): Promise<TranscriptExtractionClientResult> {
      // The voice slice's frozen pre-request gate (redirect content, length, emptiness) comes first; whole transcripts only.
      const gate = gateRemoteTranscriptExtraction(input.transcript, input.locale === "zh-SG" ? "zh" : "en");
      if (gate.kind === "WITHHOLD") return Object.freeze({ kind: "WITHHELD" as const, reason: gate.reason });
      // Then this task's own stricter request schema (e.g. control characters, allowed kinds).
      const parsed = extractionRequestSchema.safeParse({ taskType: TRANSCRIPT_EXTRACTION_TASK, contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, locale: input.locale, transcript: gate.transcript, allowedFactKinds: [...input.allowedFactKinds] });
      if (!parsed.success) return fallback("REQUEST_INVALID", false);
      const request: ExtractionRequest = parsed.data;
      const isRedirect = transcriptRedirect(request.locale);

      let decision: string;
      try {
        decision = await options.disclosure.decide(input.signal);
      } catch {
        decision = "NOT_ACCEPTED";
      }
      if (decision !== "ACCEPTED" || input.signal.aborted) return fallback("REMOTE_USE_DECLINED", false);
      const passcode = options.passcode();
      if (!passcode) return fallback("PASSCODE_MISSING", false);

      let response: Response;
      try {
        response = await fetcher(TRANSCRIPT_EXTRACTION_ROUTE_PATH, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", [AI_SHELL_ACCESS_HEADER]: passcode },
          body: JSON.stringify(request),
          // Review IMPORTANT 2: a redirect is an error (never followed with the passcode header), as in browser-shell-client.
          redirect: "error",
          signal: input.signal,
        });
      } catch {
        return fallback("NETWORK_FAILED", true);
      }
      // Review IMPORTANT 2: the response is read as text, capped at 65,536 characters and parsed strictly (as browser-shell-client).
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) return fallback("RESPONSE_INVALID", true);
        body = toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: MAX_RESPONSE_CHARS }));
      } catch {
        return fallback("RESPONSE_INVALID", true);
      }
      const answer = transcriptExtractionResponseSchema.safeParse(body);
      if (!answer.success) return fallback("RESPONSE_INVALID", true);
      const result = answer.data;
      if (result.kind === "REFUSED") return fallback("REFUSED", false, result.reason);
      if (result.kind === "FAILED") return fallback("FAILED", result.notSentToProvider !== true, result.reason);
      if (result.kind === "REJECTED") return fallback("REJECTED_BY_SERVER", true, result.reason);
      const local = validateExtraction(request, result.output, { isRedirect });
      if (local.kind === "REJECTED") return fallback("REJECTED_LOCALLY", true, local.reason);
      const mapped = mapToVoiceCandidates(local.output, request.transcript, request.locale);
      if (mapped.kind === "UNMAPPABLE") return fallback("UNMAPPABLE", true, mapped.reason);
      return Object.freeze({ kind: "EXTRACTED" as const, candidates: mapped.candidates, downgraded: mapped.downgraded, costMicroUsd: result.usage.costMicroUsd });
    },
  });
}
