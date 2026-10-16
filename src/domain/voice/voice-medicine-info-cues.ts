/**
 * HSA preview (owner decision 2026-10-14, "Tell me about my medicine"): the deterministic cue list `voice-medicine-info-cues.1` that
 * recognises a request for general information about ONE named medicine, in English only. Pure: no clock, storage, network or provider.
 *
 * A sentence is a request only when ALL of it is one of these forms (case ignored; a closing "?", "." or "!" and "please" allowed):
 *   "tell me about (my|the) X", "can/could/would you tell me about (my|the) X", "what is/what's (my|the) X", "what is/what's X (used)
 *   for", "(some) information/info about|on (my|the) X";
 * and X is a medicine name JagaOn knows exactly (case and spacing ignored): one of the patient's own medicine names or remembered terms
 * (passed in as data), or one of the named diabetes medicines below. A general word ("my insulin", "my day", "my sugar") is never a
 * request. The extractor offers a request only when the caller asks for it (HSA-bounded mode off); it is never a fact, never saved and
 * never sent to remote extraction, and the distress gate and the dose/treatment redirect still run first.
 */
export const VOICE_MEDICINE_INFO_CUES_VERSION = "voice-medicine-info-cues.1";

/** Named medicines (brand and generic) recognised without being in her list. Names only; no dose, schedule or indication. */
export const VOICE_MEDICINE_INFO_KNOWN_NAMES: readonly string[] = Object.freeze([
  "metformin",
  "glucophage",
  "lantus",
  "insulin glargine",
  "glargine",
  "toujeo",
  "apidra",
  "insulin glulisine",
  "glulisine",
  "novorapid",
  "insulin aspart",
  "humalog",
  "insulin lispro",
  "levemir",
  "insulin detemir",
  "tresiba",
  "insulin degludec",
  "insulatard",
  "mixtard",
  "gliclazide",
  "diamicron",
  "glipizide",
  "glimepiride",
  "amaryl",
  "tolbutamide",
  "sitagliptin",
  "januvia",
  "janumet",
  "linagliptin",
  "trajenta",
  "vildagliptin",
  "galvus",
  "empagliflozin",
  "jardiance",
  "dapagliflozin",
  "forxiga",
  "canagliflozin",
  "acarbose",
  "pioglitazone",
  "semaglutide",
  "ozempic",
  "rybelsus",
  "liraglutide",
  "victoza",
  "dulaglutide",
  "trulicity",
]);

export const VOICE_MEDICINE_INFO_NAME_MAX = 60;
/** The request's name rule (mirrors the medicine-information contract): letters, digits, spaces, hyphens, periods, parentheses. */
const NAME_RULE = /^[\p{L}\p{M}\p{N} .()-]+$/u;
const X = "([a-z][a-z0-9 .()-]{0,59}?)";
const OWNER = "(?:(?:my|the)\\s+)?";
const POLITE_END = "(?:\\s*,?\\s+please)?";
const REQUEST_FORMS: readonly RegExp[] = Object.freeze([
  new RegExp(`^(?:please\\s+)?(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?)?tell\\s+me\\s+(?:more\\s+)?about\\s+${OWNER}${X}${POLITE_END}$`, "u"),
  new RegExp(`^(?:what\\s+is|what's|whats)\\s+${OWNER}${X}(?:\\s+(?:used\\s+)?for)?$`, "u"),
  new RegExp(`^(?:(?:can\\s+i\\s+(?:have|get)|i\\s+want|i'd\\s+like)\\s+)?(?:some\\s+)?(?:information|info)\\s+(?:about|on)\\s+${OWNER}${X}${POLITE_END}$`, "u"),
]);

const normalise = (text: string) => text.normalize("NFC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();

/** True for a name a medicine-information request may carry. */
export function isVoiceMedicineInfoName(name: string): boolean {
  return name.length >= 1 && name.length <= VOICE_MEDICINE_INFO_NAME_MAX && name === name.trim() && !/\s{2,}/.test(name) && NAME_RULE.test(name) && /\p{L}/u.test(name);
}

/**
 * The medicine name one sentence asks about, exactly as she said it (her own casing), or null. `knownNames` are the patient's own
 * medicine names and remembered terms (exact match only).
 */
export function matchVoiceMedicineInfoRequest(sentence: string, knownNames: readonly string[]): string | null {
  if (typeof sentence !== "string") return null;
  const trimmed = sentence.trim().replace(/[\s?.!？。！]+$/u, "");
  const lowered = normalise(trimmed);
  const known = new Set([...VOICE_MEDICINE_INFO_KNOWN_NAMES, ...knownNames.map(normalise)].filter((name) => name.length > 0));
  for (const form of REQUEST_FORMS) {
    const match = form.exec(lowered);
    const wanted = match?.[1]?.trim();
    if (!wanted || !known.has(wanted)) continue;
    // Her own words for the name: the same characters of the trimmed sentence (the match ran on a lower-cased copy of equal length
    // whenever the sentence had no repeated spaces or curly quotes; otherwise the known spelling is used).
    const at = lowered.length === trimmed.length ? lowered.lastIndexOf(wanted) : -1;
    const said = at >= 0 ? trimmed.slice(at, at + wanted.length) : wanted;
    return isVoiceMedicineInfoName(said) ? said : null;
  }
  return null;
}
