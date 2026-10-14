import { VOICE_TRANSCRIPT_MAX_CODE_POINTS, codePointLength, type VoiceLanguage } from "./voice-contracts";
import { classifyVoiceAdviceRedirect, hasVoiceDoseTerm, hasVoiceQuestionForm } from "./voice-advice-redirect";
import { detectVoiceDistress } from "./voice-distress-gate";

/**
 * Packet 13 (P13S; owner requirement 6, 13s.3 Cr4): the gate the remote transcript-extraction client and route MUST call before any
 * remote request. It is STRICTER than the redirect: a transcript is WITHHELD as a whole (never sent in part, so spans stay exact) when
 * the redirect classifies it (dose/treatment or health question), when it has ANY question form (?, 吗, 要不要, 能不能, 可不可以,
 * 该不该, should/can/do I, what, how ...), or when it has ANY dose or treatment term (including a reported unit such as "10 units", and
 * 加一片, 加, 停, 不吃了, go up, go down). Its facts then come only from the deterministic extractor, beside any visible redirect.
 * Pure; it sends nothing itself.
 *
 * P13X review CRITICAL 2: every check runs in BOTH languages (a union) whatever the session language, because speech is code-switched
 * ("Sugar 15 要不要加 insulin", "血糖十五 should I take more insulin") and a transcript may arrive under the other locale.
 *
 * Owner decision 2026-10-14 (distress safety): a transcript with any distress cue (`voice-distress-gate`) is withheld FIRST, at any
 * length, as REDIRECT_CONTENT (the frozen reason set is unchanged, so every caller already refuses it before any request). The app
 * never offers remote extraction for a DISTRESS analysis either.
 *
 * Interface (frozen with voice-contract.13s.2, unchanged in 13s.3 and 13s.5):
 *   gateRemoteTranscriptExtraction(transcript: string, language: "en" | "zh"): VoiceRemoteExtractionGate
 */
export type VoiceRemoteExtractionGate =
  | Readonly<{ kind: "PERMIT"; transcript: string; language: VoiceLanguage }>
  | Readonly<{ kind: "WITHHOLD"; reason: "REDIRECT_CONTENT" | "TOO_LONG" | "EMPTY" | "INVALID" }>;

const BOTH: readonly VoiceLanguage[] = Object.freeze(["en", "zh"]);

export function gateRemoteTranscriptExtraction(transcript: string, language: VoiceLanguage): VoiceRemoteExtractionGate {
  if (typeof transcript !== "string" || (language !== "en" && language !== "zh")) return Object.freeze({ kind: "WITHHOLD", reason: "INVALID" });
  if (transcript.trim().length === 0) return Object.freeze({ kind: "WITHHOLD", reason: "EMPTY" });
  if (detectVoiceDistress(transcript).kind === "DISTRESS") return Object.freeze({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
  if (codePointLength(transcript) > VOICE_TRANSCRIPT_MAX_CODE_POINTS) return Object.freeze({ kind: "WITHHOLD", reason: "TOO_LONG" });
  const flagged = (lang: VoiceLanguage) => classifyVoiceAdviceRedirect(transcript, lang).kind === "REDIRECT" || hasVoiceQuestionForm(transcript, lang) || hasVoiceDoseTerm(transcript, lang);
  if (BOTH.some(flagged)) return Object.freeze({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
  return Object.freeze({ kind: "PERMIT", transcript, language });
}
