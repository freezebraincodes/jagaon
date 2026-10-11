/**
 * Web Speech (owner-approved scope 2026-10-11; draft): the browser speech-recognition surface the adapter uses, and feature detection.
 * Kept apart from the adapter so the app can check support (for the provider choice) without loading the adapter. No side effects.
 */
export type WebSpeechAlternativeLike = Readonly<{ transcript?: unknown }>;
export type WebSpeechResultLike = Readonly<{ isFinal?: unknown; length?: unknown; [index: number]: WebSpeechAlternativeLike | undefined }>;
export type WebSpeechResultEventLike = Readonly<{ resultIndex?: unknown; results?: Readonly<{ length?: unknown; [index: number]: WebSpeechResultLike | undefined }> }>;
export type WebSpeechErrorEventLike = Readonly<{ error?: unknown }>;

export type WebSpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: unknown) => void) | null;
  onresult: ((event: WebSpeechResultEventLike) => void) | null;
  onerror: ((event: WebSpeechErrorEventLike) => void) | null;
  onend: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
export type WebSpeechRecognitionConstructor = new () => WebSpeechRecognitionLike;

/** Feature detection: the standard or the prefixed constructor, or null. Never throws. */
export function detectWebSpeechRecognition(target: unknown = globalThis): WebSpeechRecognitionConstructor | null {
  try {
    const scope = target as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown } | null;
    const candidate = scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition;
    return typeof candidate === "function" ? (candidate as WebSpeechRecognitionConstructor) : null;
  } catch {
    return null;
  }
}

export const isWebSpeechSupported = (target: unknown = globalThis): boolean => detectWebSpeechRecognition(target) !== null;
