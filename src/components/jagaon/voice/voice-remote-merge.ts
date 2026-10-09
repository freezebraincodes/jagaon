import { normaliseVoicePhrase, type VoiceMedicineDirectory } from "@/domain/voice/voice-candidate-extractor";
import {
  VOICE_AMBIGUITY_REASONS,
  VOICE_MAX_CANDIDATES,
  candidateMatchesTranscript,
  voiceAnalysisSchema,
  voiceCandidateSchema,
  type VoiceAmbiguityReason,
  type VoiceAnalysis,
  type VoiceCandidate,
  type VoiceLanguage,
} from "@/domain/voice/voice-contracts";

/**
 * Packet 13 (P13S): merges validated remote-extraction candidates into the LOCAL analysis. The local analysis is the floor:
 * - every remote candidate must parse with the frozen contract, be `source: "REMOTE_EXTRACTION"` and match the transcript exactly;
 *   anything else, or an invalid merged result, falls back to the local analysis unchanged;
 * - remote facts never replace or weaken a local fact: where they overlap a local fact of the same kind, the local fact stays and only
 *   becomes stricter (the remote safety reasons are added); a remote fact of another kind over a local fact is dropped;
 * - a remote fact over text the local extractor did not understand is added, with every transcript-wide local safety flag
 *   (correction, another person) and the local safety flags of the text it covers;
 * - a remote glucose unit counts as SPOKEN only when an mmol unit is in its own phrase; an app default is a local decision, never
 *   remote; a remote medicine is always re-resolved locally (UNRESOLVED unless the patient's remembered term or an exact canonical
 *   name maps it);
 * - terminology review #2: a remote medicine phrase must lie inside its own span (the words the person said for it); a remote
 *   occurrence whose phrase does not is dropped, so its text stays not understood (UNSUPPORTED) and nothing can be remembered from it;
 * - safety reasons are NEGATION, UNCERTAINTY, CORRECTION, OTHER_PERSON and MULTIPLE_NUMBERS; adding one to an app-default reading
 *   returns it to an unstated unit (the default applies only to an unambiguous reading).
 */
const SAFETY: readonly VoiceAmbiguityReason[] = ["NEGATION", "UNCERTAINTY", "CORRECTION", "OTHER_PERSON", "MULTIPLE_NUMBERS"];
const TRANSCRIPT_WIDE: readonly VoiceAmbiguityReason[] = ["CORRECTION", "OTHER_PERSON"];
const MMOL = /mmol|毫摩尔|millimole/i;

type Fact = Exclude<VoiceCandidate, { kind: "UNSUPPORTED_SPAN" }>;
const overlaps = (left: VoiceCandidate, right: VoiceCandidate) => left.span.start < right.span.end && right.span.start < left.span.end;
const isFact = (candidate: VoiceCandidate): candidate is Fact => candidate.kind !== "UNSUPPORTED_SPAN";

function withReasons(candidate: Fact, extra: readonly VoiceAmbiguityReason[]): Fact {
  const reasons = new Set<VoiceAmbiguityReason>([...candidate.ambiguity, ...extra.filter((reason) => SAFETY.includes(reason))]);
  if (candidate.kind === "MEAL_NOTE") for (const reason of ["MULTIPLE_NUMBERS"] as const) reasons.delete(reason);
  if (candidate.kind === "MEDICATION_OCCURRENCE") reasons.delete("MULTIPLE_NUMBERS");
  let next: Fact = candidate;
  if (candidate.kind === "GLUCOSE_READING" && candidate.unitSource === "APP_DEFAULT" && [...reasons].some((reason) => SAFETY.includes(reason))) {
    reasons.add("UNIT_UNSTATED");
    next = { ...candidate, unit: "UNSTATED", unitSource: null };
  }
  const ambiguity = VOICE_AMBIGUITY_REASONS.filter((reason) => reasons.has(reason));
  return Object.freeze({ ...next, ambiguity, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS" }) as Fact;
}

function resolveMedicine(candidate: Fact, language: VoiceLanguage, directory: VoiceMedicineDirectory): Fact {
  if (candidate.kind !== "MEDICATION_OCCURRENCE") return candidate;
  const phrase = candidate.medicineRef.phrase;
  const normal = normaliseVoicePhrase(phrase, language);
  const term = directory.terms.find((entry) => normaliseVoicePhrase(entry.phrase, language) === normal);
  const name = term ? undefined : directory.names.find((entry) => normaliseVoicePhrase(entry.name, language) === normal);
  const medicineRef = term
    ? ({ kind: "MAPPED", phrase, medication: term.medication, via: "TERMINOLOGY" } as const)
    : name
      ? ({ kind: "MAPPED", phrase, medication: name.medication, via: "EXACT_NAME" } as const)
      : ({ kind: "UNRESOLVED", phrase } as const);
  const reasons: readonly VoiceAmbiguityReason[] = candidate.ambiguity.filter((reason) => reason !== "MEDICINE_UNRESOLVED");
  const ambiguity = VOICE_AMBIGUITY_REASONS.filter((reason) => reasons.includes(reason) || (reason === "MEDICINE_UNRESOLVED" && medicineRef.kind === "UNRESOLVED"));
  return Object.freeze({ ...candidate, medicineRef, ambiguity, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS" });
}

function normaliseRemoteGlucose(candidate: Fact): Fact {
  if (candidate.kind !== "GLUCOSE_READING") return candidate;
  if (candidate.unitSource === "SPOKEN" && MMOL.test(candidate.sourcePhrase)) return candidate;
  if (candidate.unit === "UNSTATED") return candidate;
  const ambiguity = VOICE_AMBIGUITY_REASONS.filter((reason) => reason === "UNIT_UNSTATED" || candidate.ambiguity.includes(reason));
  return Object.freeze({ ...candidate, unit: "UNSTATED", unitSource: null, ambiguity, state: "AMBIGUOUS" });
}

export type VoiceRemoteMerge = Readonly<{ kind: "MERGED"; analysis: Extract<VoiceAnalysis, { kind: "ANALYSED" }> }> | Readonly<{ kind: "LOCAL_KEPT" }>;

export function mergeRemoteCandidates(input: Readonly<{
  local: Extract<VoiceAnalysis, { kind: "ANALYSED" }>;
  remote: readonly unknown[];
  transcript: string;
  language: VoiceLanguage;
  directory: VoiceMedicineDirectory;
}>): VoiceRemoteMerge {
  try {
    const remote: Fact[] = [];
    for (const value of input.remote) {
      const parsed = voiceCandidateSchema.safeParse(value);
      if (!parsed.success || parsed.data.source !== "REMOTE_EXTRACTION" || !candidateMatchesTranscript(parsed.data, input.transcript)) return { kind: "LOCAL_KEPT" };
      if (!isFact(parsed.data)) continue;
      // Terminology review #2: the medicine phrase must be words of the candidate's own span; otherwise drop the candidate.
      if (parsed.data.kind === "MEDICATION_OCCURRENCE" && !parsed.data.sourcePhrase.includes(parsed.data.medicineRef.phrase)) continue;
      remote.push(parsed.data);
    }
    const localFacts = input.local.candidates.filter(isFact);
    const wide = TRANSCRIPT_WIDE.filter((reason) => localFacts.some((candidate) => candidate.ambiguity.includes(reason)));
    const stricter = new Map<Fact, Set<VoiceAmbiguityReason>>();
    const added: Fact[] = [];
    for (const candidate of remote) {
      const overlapping = localFacts.filter((local) => overlaps(local, candidate));
      if (overlapping.length > 0) {
        for (const local of overlapping.filter((entry) => entry.kind === candidate.kind)) {
          const reasons = stricter.get(local) ?? new Set<VoiceAmbiguityReason>();
          for (const reason of candidate.ambiguity) reasons.add(reason);
          stricter.set(local, reasons);
        }
        continue;
      }
      const prepared = resolveMedicine(normaliseRemoteGlucose(candidate), input.language, input.directory);
      added.push(withReasons(prepared, wide));
    }
    const kept = input.local.candidates
      .filter((candidate) => isFact(candidate) || !added.some((fact) => overlaps(fact, candidate)))
      .map((candidate) => (isFact(candidate) && stricter.has(candidate) ? withReasons(candidate, [...stricter.get(candidate)!]) : candidate));
    const candidates = [...kept, ...added].sort((left, right) => left.span.start - right.span.start);
    const merged = {
      ...input.local,
      candidates: candidates.slice(0, VOICE_MAX_CANDIDATES),
      truncated: input.local.truncated || candidates.length > VOICE_MAX_CANDIDATES,
    };
    const valid = voiceAnalysisSchema.safeParse(merged);
    if (!valid.success || valid.data.kind !== "ANALYSED") return { kind: "LOCAL_KEPT" };
    return { kind: "MERGED", analysis: valid.data };
  } catch {
    return { kind: "LOCAL_KEPT" };
  }
}
