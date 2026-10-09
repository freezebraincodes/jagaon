import { classifyVoiceAdviceRedirect } from "@/domain/voice/voice-advice-redirect";
import type { TranscriptExtractionLocale } from "@/domain/transcript-extraction/transcript-extraction-contract";

/**
 * Packet 13 (P13X): the deterministic dose/treatment redirect, applied BEFORE any extraction call (in the browser client and again in
 * the route) and to every extracted fact span (validator r4). It is the voice slice's own classifier (src/domain/voice, imported
 * read-only), so the voice flow and the extraction share one definition: over-redirect is the safe direction.
 *
 * Review CRITICAL 2: speech is often code-switched ("Sugar 15 要不要加 insulin", "血糖十五 should I take more insulin"), and the
 * locale says only which language the person chose. So the EN and ZH classifiers are applied TOGETHER (a union) for every locale.
 * The locale parameter is kept for the call sites' shape.
 */
export function transcriptRedirect(_locale: TranscriptExtractionLocale): (text: string) => boolean {
  return (text: string) => classifyVoiceAdviceRedirect(text, "en").kind === "REDIRECT" || classifyVoiceAdviceRedirect(text, "zh").kind === "REDIRECT";
}
