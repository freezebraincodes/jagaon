import type { VoiceLanguage } from "@/domain/voice/voice-contracts";

/**
 * Packet 13 slice (P13S, S4): the voice-cloud disclosure state model, copy `voice-disclosure.13s.1` (keys only; the copy is
 * coordinator-owned, Q13-4, human acceptance pending).
 *
 * - Required before EVERY microphone start (mirrors U01): an accepted disclosure (state GRANTED; the word "ACCEPTED" is reserved for the
 *   AI wording disclosure's pinned decision literal) holds ONE one-shot grant for one start in one language.
 *   After the grant is handed to a start (`GRANT_USED`) the model is IDLE again, so the next start shows the disclosure again.
 * - Never persisted (no storage of any kind), and independent of the remote-AI wording disclosure and of `keepWordingOnDevice` (U05):
 *   this module imports neither.
 * - A locale change or a navigation makes an open or accepted disclosure MOOT; a decline gives no grant. Leaving ACCEPTED any other
 *   way than `GRANT_USED` revokes the grant.
 *
 * The reducer is deterministic. Its only side effect is the module-private grant registry (issued and spent grants, held weakly), which
 * makes a grant unforgeable and single-use: `consumeVoiceDisclosureGrant` admits an issued, unrevoked grant exactly once.
 */
export const VOICE_DISCLOSURE_COPY_VERSION = "voice-disclosure.13s.1";
export const VOICE_DISCLOSURE_COPY_KEYS = Object.freeze({
  title: "voice.disclosure.title",
  body: "voice.disclosure.body",
  accept: "voice.disclosure.accept",
  decline: "voice.disclosure.decline",
} as const);

declare const voiceGrant: unique symbol;
/** An opaque one-shot grant for one microphone start in one language. */
export type VoiceDisclosureGrant = Readonly<{ [voiceGrant]: true; language: VoiceLanguage }>;

export type VoiceDisclosureState =
  | Readonly<{ kind: "IDLE" }>
  | Readonly<{ kind: "SHOWN"; language: VoiceLanguage }>
  | Readonly<{ kind: "GRANTED"; language: VoiceLanguage; grant: VoiceDisclosureGrant }>
  | Readonly<{ kind: "DECLINED" }>
  | Readonly<{ kind: "MOOT" }>;

export type VoiceDisclosureAction =
  | Readonly<{ type: "REQUEST_START"; language: VoiceLanguage }>
  | Readonly<{ type: "ACCEPT" }>
  | Readonly<{ type: "DECLINE" }>
  | Readonly<{ type: "LOCALE_CHANGED" }>
  | Readonly<{ type: "NAVIGATED" }>
  | Readonly<{ type: "GRANT_USED" }>
  | Readonly<{ type: "RESET" }>;

export const VOICE_DISCLOSURE_INITIAL_STATE: VoiceDisclosureState = Object.freeze({ kind: "IDLE" });

const issued = new WeakSet<object>();
const spent = new WeakSet<object>();

function issue(language: VoiceLanguage): VoiceDisclosureGrant {
  const grant = Object.freeze({ language }) as VoiceDisclosureGrant;
  issued.add(grant);
  return grant;
}

/** Leaving ACCEPTED other than by GRANT_USED revokes the grant it held. */
function leave(state: VoiceDisclosureState, next: VoiceDisclosureState): VoiceDisclosureState {
  if (state.kind === "GRANTED") spent.add(state.grant);
  return next;
}

export function voiceDisclosureReducer(state: VoiceDisclosureState, action: VoiceDisclosureAction): VoiceDisclosureState {
  switch (action.type) {
    case "REQUEST_START":
      return action.language === "en" || action.language === "zh" ? leave(state, Object.freeze({ kind: "SHOWN", language: action.language })) : state;
    case "ACCEPT":
      return state.kind === "SHOWN" ? Object.freeze({ kind: "GRANTED", language: state.language, grant: issue(state.language) }) : state;
    case "DECLINE":
      return state.kind === "SHOWN" || state.kind === "GRANTED" ? leave(state, Object.freeze({ kind: "DECLINED" })) : state;
    case "LOCALE_CHANGED":
    case "NAVIGATED":
      return state.kind === "SHOWN" || state.kind === "GRANTED" ? leave(state, Object.freeze({ kind: "MOOT" })) : state;
    case "GRANT_USED":
      return state.kind === "GRANTED" ? VOICE_DISCLOSURE_INITIAL_STATE : state;
    case "RESET":
      return leave(state, VOICE_DISCLOSURE_INITIAL_STATE);
    default:
      return state;
  }
}

/** True when the value is an issued grant that was neither revoked nor used (does not spend it). */
export function isVoiceDisclosureGrantUsable(grant: unknown): grant is VoiceDisclosureGrant {
  return typeof grant === "object" && grant !== null && issued.has(grant) && !spent.has(grant);
}

/** Spends the grant: true exactly once for an issued, unrevoked grant; false for anything else (forged, revoked or already used). */
export function consumeVoiceDisclosureGrant(grant: unknown): boolean {
  if (!isVoiceDisclosureGrantUsable(grant)) return false;
  spent.add(grant);
  return true;
}
