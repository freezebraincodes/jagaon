import { z } from "zod";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest, type AiTaskActivationState } from "@/application/ai/ai-activation-manifest";
import { AI_REQUEST_CLASS_QUALIFICATION_STATUSES } from "@/application/ai/request-class-qualification";
import { TRANSCRIPT_EXTRACTION_TASK } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";

/**
 * Packet 13 (P13X): remote eligibility of EXTRACT_VOICE_FACTS. Browser-safe.
 *
 * Qualification is this task's OWN record, bound to the extraction contract digest (transcriptExtractionContractDigest: prompt, schema,
 * request profile, model, sampling, cap, validator and lexicon versions). The value-blind wording route's request-class qualification is
 * never consulted and is no evidence here (owner, 2026-10-09). Shipped exactly one PENDING record with no evidence: nothing is
 * qualified, and no code path sets QUALIFIED. A QUALIFIED record needs an evidence reference, the signer and the sign-off instant, and
 * only the owner's sign-off may change it (after the FULL evaluation in src/ai/evaluation/transcript-extraction/).
 *
 * Activation is read from the shared AI activation manifest. Until the queued diff registers the task, the manifest has no entry and the
 * task is NOT_REGISTERED; once registered it ships DETERMINISTIC_ONLY. Only SYNTHETIC_REMOTE_ENABLED under HACKATHON_DEMO admits a call.
 */
export const TRANSCRIPT_EXTRACTION_ELIGIBILITY_POLICY_VERSION = "transcript-extraction-eligibility.13.1";

/**
 * The qualification statuses come from the Packet 11C C1 module's closed status list (the only product module that may spell the
 * qualified status), so this module holds no fresh status literal and cannot mark anything qualified by itself.
 */
type QualifiedStatus = Exclude<(typeof AI_REQUEST_CLASS_QUALIFICATION_STATUSES)[number], "PENDING">;
// Review minor: selected by value (the one status that is not PENDING), not by position; a changed list fails at load, never silently.
const QUALIFIED_STATUSES = AI_REQUEST_CLASS_QUALIFICATION_STATUSES.filter((status): status is QualifiedStatus => status !== "PENDING");
if (QUALIFIED_STATUSES.length !== 1) throw new Error("QUALIFICATION_STATUSES_CHANGED");
const QUALIFIED_STATUS: QualifiedStatus = QUALIFIED_STATUSES[0]!;

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z.string().min(1).max(512).refine((value) => value.trim() === value);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine((value) => !Number.isNaN(Date.parse(value)));

export const transcriptExtractionQualificationRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ taskType: z.literal(TRANSCRIPT_EXTRACTION_TASK), contractDigest: digest, status: z.literal("PENDING"), evidenceRef: reference.nullable(), signedOffBy: z.null(), signedOffAt: z.null() }),
  z.strictObject({ taskType: z.literal(TRANSCRIPT_EXTRACTION_TASK), contractDigest: digest, status: z.literal(QUALIFIED_STATUS), evidenceRef: reference, signedOffBy: reference, signedOffAt: instant }),
]);
export type TranscriptExtractionQualificationRecord = z.infer<typeof transcriptExtractionQualificationRecordSchema>;

/** Shipped: PENDING for the current contract digest (pinned against the server-side digest in the route tests). */
export const TRANSCRIPT_EXTRACTION_QUALIFICATION_RECORDS: readonly TranscriptExtractionQualificationRecord[] = Object.freeze([
  Object.freeze({ taskType: TRANSCRIPT_EXTRACTION_TASK, contractDigest: "c42e1ec3f560be914d59d4050228f0f1e192ba0ac54b4cb8a42e8c705bda0d79", status: "PENDING" as const, evidenceRef: null, signedOffBy: null, signedOffAt: null }),
]);

export type TranscriptExtractionGate = Readonly<{ admit(contractDigest: string): boolean }>;

/** Admits only when exactly one schema-valid record names this digest and it is QUALIFIED. Anything else is not qualified. */
export function transcriptExtractionGate(records: readonly unknown[]): TranscriptExtractionGate {
  return Object.freeze({
    admit(contractDigest: string): boolean {
      const named = records.filter((record) => typeof record === "object" && record !== null && (record as { contractDigest?: unknown }).contractDigest === contractDigest);
      if (named.length !== 1) return false;
      const parsed = transcriptExtractionQualificationRecordSchema.safeParse(named[0]);
      return parsed.success && parsed.data.status === QUALIFIED_STATUS;
    },
  });
}
export const SHIPPED_TRANSCRIPT_EXTRACTION_GATE = transcriptExtractionGate(TRANSCRIPT_EXTRACTION_QUALIFICATION_RECORDS);

export type TranscriptExtractionActivation = AiTaskActivationState | "NOT_REGISTERED" | "PROFILE_NOT_PERMITTED";

/**
 * Reads this task's state from the shared manifest without requiring the 11A task union to know it: the queued additive
 * `separateTasks` field (Q13X-1) first, else a `tasks` entry. Neither present: NOT_REGISTERED (refused).
 */
export function transcriptExtractionActivation(manifest: AiActivationManifest, profile: unknown): TranscriptExtractionActivation {
  const read = (record: unknown): string | undefined =>
    typeof record === "object" && record !== null && Object.hasOwn(record, TRANSCRIPT_EXTRACTION_TASK) ? String((record as Record<string, unknown>)[TRANSCRIPT_EXTRACTION_TASK]) : undefined;
  const state = read((manifest as { separateTasks?: unknown }).separateTasks) ?? read(manifest.tasks);
  if (state === undefined) return "NOT_REGISTERED";
  if (profile !== "HACKATHON_DEMO" || manifest.profile !== "HACKATHON_DEMO") return "PROFILE_NOT_PERMITTED";
  return state === "SYNTHETIC_REMOTE_ENABLED" || state === "DETERMINISTIC_ONLY" || state === "REGISTERED_DISABLED" ? state : "REGISTERED_DISABLED";
}

/**
 * Browser-side switch for offering remote extraction in the voice review: true only when this task is SYNTHETIC_REMOTE_ENABLED for the
 * HACKATHON_DEMO storage profile (the same lookup and profile the route uses). False for the shipped manifest (not registered). This
 * only decides whether the offer appears; the route still enforces its switches, access, its own qualification and its own budget.
 */
export function isTranscriptExtractionActivated(manifest: AiActivationManifest = AI_ACTIVATION_MANIFEST): boolean {
  return transcriptExtractionActivation(manifest, HACKATHON_STORAGE_PROFILE.profileId) === "SYNTHETIC_REMOTE_ENABLED";
}
