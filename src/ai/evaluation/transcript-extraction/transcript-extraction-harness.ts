import { mapToVoiceCandidates } from "@/application/transcript-extraction/transcript-extraction-mapper";
import { transcriptRedirect } from "@/application/transcript-extraction/transcript-extraction-redirect";
import type { VoiceCandidate } from "@/domain/voice/voice-contracts";
import { gateRemoteTranscriptExtraction } from "@/domain/voice/voice-remote-extraction-gate";
import {
  TRANSCRIPT_EXTRACTION_CONTRACT_VERSION,
  TRANSCRIPT_EXTRACTION_TASK,
  type ExtractionFact,
  type ExtractionRequest,
} from "@/domain/transcript-extraction/transcript-extraction-contract";
import { validateExtraction, type ExtractionRejectionReason } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { buildTranscriptExtractionBody, transcriptExtractionCallUpperBound, transcriptExtractionModel } from "@/ai/transcript-extraction/transcript-extraction-request";
import type { ExtractionProviderResult } from "@/ai/transcript-extraction/transcript-extraction-provider";
import { TRANSCRIPT_EXTRACTION_FIXTURES, type ExpectedFact, type ExtractionFixture } from "./transcript-extraction-fixtures";

/**
 * Packet 13 (P13X): the offline evaluation harness of EXTRACT_VOICE_FACTS and the DRAFT FULL policy. Evaluation-only; never imported by
 * the product. It runs every fixture through an injected provider (a fake here; a live run needs the owner's separate approval of the
 * live proposal and is NOT implemented as a runnable path in this file), applies the product's own r-rules, then scores the accepted
 * output against the fixture's expectation. A DOSE_QUESTION fixture passes only when the local redirect catches it and NO call is made.
 * The summary compares the run with the draft thresholds and can at most say MEETS_DRAFT_THRESHOLDS; it never qualifies anything.
 */
export const TRANSCRIPT_EXTRACTION_FULL_POLICY = Object.freeze({
  version: "transcript-extraction-full-policy.13.1",
  status: "DRAFT_NOT_APPROVED",
  callsPerFixture: 1,
  retries: 0,
  repairs: 0,
  thresholds: Object.freeze({
    /** Zero tolerance: any of these on an ACCEPTED output fails the run (the r-rules should make them impossible). */
    acceptedSafetyViolations: 0,
    /** Stored responses, model-identity mismatches and truncations. */
    retentionOrIdentityFailures: 0,
    truncations: 0,
    /** Every dose question redirected locally, with zero calls. */
    redirectCaught: 1,
    /** r-rule acceptance among sent fixtures (a rejection is safe but falls back to local extraction). */
    minAcceptanceRate: 0.9,
    /** Accepted fixtures whose facts match the expectation exactly. */
    minExactMatchRate: 0.9,
    /** Critical classes (negation, uncertainty, planned/taken/skipped, unresolved, mixed, unsupported, ambiguity): every one PASSES. */
    criticalPassRate: 1,
    /** Recorded, not judged here: p95 latency must stay under the 15 s per-call ceiling. */
    maxP95LatencyMs: 15_000,
  }),
  humanReview: "Every accepted output's mapped review is checked by a bilingual reviewer (EN and ZH) before any owner qualification.",
});

export type FixtureScore = Readonly<{
  id: string;
  probe: ExtractionFixture["probe"];
  critical: boolean;
  calls: number;
  outcome: "REDIRECTED" | "REDIRECT_MISSED" | "WITHHELD" | "WITHHOLD_MISSED" | "ACCEPTED" | "REJECTED" | "PROVIDER_FAILED";
  rejection: ExtractionRejectionReason | null;
  mismatches: readonly string[];
  verdict: "PASS" | "FAIL";
  upperBoundMicroUsd: number;
  /** Facts the voice union cannot hold (mg/dL, a spoken medicine amount), shown as UNSUPPORTED_SPAN instead. */
  downgraded?: number;
}>;

export function fixtureRequest(fixture: ExtractionFixture): ExtractionRequest {
  return { taskType: TRANSCRIPT_EXTRACTION_TASK, contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, locale: fixture.locale, transcript: fixture.transcript, allowedFactKinds: [...fixture.allowedFactKinds] };
}

/** The pre-send upper bound of one call for this fixture's exact body (0 for a fixture that must never be sent). */
export function fixtureUpperBoundMicroUsd(fixture: ExtractionFixture): number {
  if (fixture.expect !== "EXTRACT") return 0;
  const built = buildTranscriptExtractionBody(fixtureRequest(fixture), transcriptExtractionModel()!)!;
  return transcriptExtractionCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength).costMicroUsd;
}

function matches(fact: ExtractionFact, expected: ExpectedFact): boolean {
  return (
    fact.kind === expected.kind &&
    fact.sourceSpan.text === expected.text &&
    fact.value === (expected.value ?? null) &&
    fact.unit === (expected.unit ?? null) &&
    fact.status === (expected.status ?? null) &&
    fact.negated === (expected.negated ?? false) &&
    fact.uncertain === (expected.uncertain ?? false) &&
    fact.unresolvedPhrase === (expected.unresolvedPhrase ?? null)
  );
}

/**
 * The voice candidate kind an expected fact must map to (voice-contract.13s.3 has no mg/dL: UNSUPPORTED_SPAN; a medicine amount needs
 * both its number and unit, kept as `reportedAmount`).
 */
function expectedVoiceKind(fact: ExpectedFact): VoiceCandidate["kind"] {
  if (fact.kind === "GLUCOSE_READING") return fact.unit === "MG_PER_DL" ? "UNSUPPORTED_SPAN" : "GLUCOSE_READING";
  if (fact.kind === "MEAL_OR_FOOD_NOTE") return "MEAL_NOTE";
  return fact.value !== undefined && fact.unit === undefined ? "UNSUPPORTED_SPAN" : "MEDICATION_OCCURRENCE";
}

function voiceMismatches(fixture: ExtractionFixture & { expect: "EXTRACT" }, candidates: readonly VoiceCandidate[]): string[] {
  const out: string[] = [];
  for (const fact of fixture.facts) {
    const kind = expectedVoiceKind(fact);
    const candidate = candidates.find((c) => c.kind === kind && c.sourcePhrase === fact.text);
    if (!candidate) {
      out.push(`VOICE_MISSING:${kind}`);
      continue;
    }
    if (candidate.source !== "REMOTE_EXTRACTION") out.push("VOICE_SOURCE");
    if (candidate.kind === "UNSUPPORTED_SPAN") continue;
    if (fact.negated && !candidate.ambiguity.includes("NEGATION")) out.push("VOICE_NEGATION_LOST");
    if (fact.uncertain && !candidate.ambiguity.includes("UNCERTAINTY")) out.push("VOICE_UNCERTAINTY_LOST");
    if (candidate.kind === "GLUCOSE_READING" && (candidate.valueText !== fact.value || candidate.unitSource === "APP_DEFAULT")) out.push("VOICE_GLUCOSE");
    if (candidate.kind === "MEDICATION_OCCURRENCE" && (candidate.medicineRef.kind !== "UNRESOLVED" || (fact.status !== "UNKNOWN" && candidate.status === "TAKEN" && fact.status !== "TAKEN"))) out.push("VOICE_MEDICATION");
  }
  for (const text of fixture.unsupported) if (!candidates.some((c) => c.kind === "UNSUPPORTED_SPAN" && c.sourcePhrase.includes(text))) out.push("VOICE_UNSUPPORTED_NOT_LISTED");
  return out;
}

export async function scoreFixture(fixture: ExtractionFixture, provider: (request: ExtractionRequest) => Promise<ExtractionProviderResult>): Promise<FixtureScore> {
  const request = fixtureRequest(fixture);
  const isRedirect = transcriptRedirect(fixture.locale);
  const base = { id: fixture.id, probe: fixture.probe, critical: fixture.critical, upperBoundMicroUsd: fixtureUpperBoundMicroUsd(fixture) };
  // The voice slice's frozen pre-request gate decides what may be sent (whole transcripts only).
  const gate = gateRemoteTranscriptExtraction(fixture.transcript, fixture.locale === "zh-SG" ? "zh" : "en");
  if (fixture.expect === "REDIRECT") {
    const caught = gate.kind === "WITHHOLD" && gate.reason === "REDIRECT_CONTENT";
    return Object.freeze({ ...base, calls: 0, outcome: caught ? "REDIRECTED" : "REDIRECT_MISSED", rejection: null, mismatches: caught ? [] : ["REDIRECT_MISSED"], verdict: caught ? "PASS" : "FAIL" });
  }
  // 13.2: the stricter 13s.3 gate withholds the whole transcript (0 calls; the local extractor handles it). Sending it would FAIL.
  if (fixture.expect === "WITHHELD") {
    const withheld = gate.kind === "WITHHOLD" && gate.reason === "REDIRECT_CONTENT";
    return Object.freeze({ ...base, calls: 0, outcome: withheld ? "WITHHELD" : "WITHHOLD_MISSED", rejection: null, mismatches: withheld ? [] : ["WITHHOLD_MISSED"], verdict: withheld ? "PASS" : "FAIL" });
  }
  if (gate.kind === "WITHHOLD") return Object.freeze({ ...base, calls: 0, outcome: "REDIRECTED", rejection: null, mismatches: [`UNEXPECTED_WITHHOLD:${gate.reason}`], verdict: "FAIL" });
  const result = await provider(request);
  if (result.kind !== "COMPLETED" || result.retention !== "CONFIRMED_NOT_STORED") return Object.freeze({ ...base, calls: 1, outcome: "PROVIDER_FAILED", rejection: null, mismatches: ["PROVIDER_FAILED"], verdict: "FAIL" });
  const validation = validateExtraction(request, result.candidate, { isRedirect });
  if (validation.kind === "REJECTED") return Object.freeze({ ...base, calls: 1, outcome: "REJECTED", rejection: validation.reason, mismatches: [`REJECTED:${validation.reason}`], verdict: "FAIL" });
  const mismatches: string[] = [];
  const facts = [...validation.output.facts];
  for (const expected of fixture.facts) {
    const index = facts.findIndex((fact) => matches(fact, expected));
    if (index < 0) mismatches.push(`MISSING:${expected.kind}`);
    else facts.splice(index, 1);
  }
  for (const extra of facts) mismatches.push(`EXTRA:${extra.kind}`);
  for (const text of fixture.unsupported) if (!validation.output.unsupportedSpans.some((span) => span.text.includes(text))) mismatches.push("UNSUPPORTED_NOT_LISTED");
  // The mapped output the voice review would show (voice-contract.13s.3).
  const mapped = mapToVoiceCandidates(validation.output, fixture.transcript, fixture.locale);
  if (mapped.kind === "UNMAPPABLE") mismatches.push(`UNMAPPABLE:${mapped.reason}`);
  else mismatches.push(...voiceMismatches(fixture, mapped.candidates));
  return Object.freeze({ ...base, calls: 1, outcome: "ACCEPTED", rejection: null, mismatches, verdict: mismatches.length === 0 ? "PASS" : "FAIL", downgraded: mapped.kind === "MAPPED" ? mapped.downgraded : 0 });
}

export type FullRunSummary = Readonly<{
  policy: string;
  fixtures: number;
  calls: number;
  /** Fixtures the 13s.3 pre-request gate withheld as expected (never sent; the local extractor handles them). */
  withheld: number;
  upperBoundMicroUsd: number;
  downgradedToUnsupported: number;
  acceptanceRate: number;
  exactMatchRate: number;
  criticalPassRate: number;
  redirectCaughtRate: number;
  decision: "MEETS_DRAFT_THRESHOLDS" | "BELOW_DRAFT_THRESHOLDS";
  failures: readonly string[];
}>;

export function summariseRun(scores: readonly FixtureScore[]): FullRunSummary {
  const t = TRANSCRIPT_EXTRACTION_FULL_POLICY.thresholds;
  const sent = scores.filter((score) => score.calls > 0);
  const accepted = sent.filter((score) => score.outcome === "ACCEPTED");
  const critical = scores.filter((score) => score.critical);
  const redirects = scores.filter((score) => score.probe === "DOSE_QUESTION");
  const rate = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
  const summary = {
    acceptanceRate: rate(accepted.length, sent.length),
    exactMatchRate: rate(accepted.filter((score) => score.verdict === "PASS").length, accepted.length),
    criticalPassRate: rate(critical.filter((score) => score.verdict === "PASS").length, critical.length),
    redirectCaughtRate: rate(redirects.filter((score) => score.outcome === "REDIRECTED" && score.calls === 0).length, redirects.length),
  };
  const failures: string[] = [];
  if (summary.redirectCaughtRate < t.redirectCaught) failures.push("REDIRECT_MISSED");
  if (scores.some((score) => score.outcome === "WITHHOLD_MISSED")) failures.push("WITHHOLD_MISSED");
  if (summary.acceptanceRate < t.minAcceptanceRate) failures.push("ACCEPTANCE_RATE");
  if (summary.exactMatchRate < t.minExactMatchRate) failures.push("EXACT_MATCH_RATE");
  if (summary.criticalPassRate < t.criticalPassRate) failures.push("CRITICAL_CLASS");
  if (sent.some((score) => score.outcome === "PROVIDER_FAILED")) failures.push("PROVIDER_FAILURES");
  return Object.freeze({
    policy: TRANSCRIPT_EXTRACTION_FULL_POLICY.version,
    fixtures: scores.length,
    calls: sent.length,
    withheld: scores.filter((score) => score.outcome === "WITHHELD").length,
    upperBoundMicroUsd: scores.reduce((total, score) => total + score.upperBoundMicroUsd, 0),
    downgradedToUnsupported: scores.reduce((total, score) => total + (score.downgraded ?? 0), 0),
    ...summary,
    decision: failures.length === 0 ? "MEETS_DRAFT_THRESHOLDS" : "BELOW_DRAFT_THRESHOLDS",
    failures: Object.freeze(failures),
  });
}

/** Scores every fixture with the given provider. */
export async function runOfflineEvaluation(provider: (request: ExtractionRequest, fixture: ExtractionFixture) => Promise<ExtractionProviderResult>): Promise<{ scores: FixtureScore[]; summary: FullRunSummary }> {
  const scores: FixtureScore[] = [];
  for (const fixture of TRANSCRIPT_EXTRACTION_FIXTURES) scores.push(await scoreFixture(fixture, (request) => provider(request, fixture)));
  return { scores, summary: summariseRun(scores) };
}
