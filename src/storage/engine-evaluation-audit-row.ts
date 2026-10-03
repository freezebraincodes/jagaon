import { z } from "zod";
import { sha256DigestSchema, type Sha256Digest } from "@/application/contracts/canonical-json";
import { instantSchema, type Instant } from "@/domain/shared";
import { anyTypedRevisionRefSchema, uniqueRefListSchema } from "@/domain/learning";
import { PATTERN_LIMITATION_CODES } from "@/domain/patterns";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import { REVERSE_DEPENDENCY_EVALUATORS } from "./reverse-dependency-row";

/**
 * Engine-evaluation audit row (storage-backup-spec Section 2.7). It keeps the
 * non-payload evaluation envelope only: identities, versions, exact revision
 * references, fingerprints, disposition and closed codes. No health value,
 * label or rendered wording is stored.
 */

export const ENGINE_DECISION_REASON_CODES = Object.freeze([
  "PATTERN_OBSERVATION_CREATED",
  "PATTERN_OBSERVATION_REVISED",
  "PATTERN_OBSERVATION_TRANSITIONED",
  "PATTERN_DERIVED_CONTENT_DELETED",
  "LEARNED_KNOWLEDGE_CREATED",
  "LEARNED_KNOWLEDGE_REVISED",
  "LEARNED_KNOWLEDGE_TRANSITIONED",
  "LEARNED_DERIVED_CONTENT_DELETED",
] as const);

export type EngineDecisionReasonCode = (typeof ENGINE_DECISION_REASON_CODES)[number];

const RUNTIME_MANIFESTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "jagaon-hackathon-intelligence": ["7a.1"],
});

const ENGINE_BY_OWNER = { PATTERN_ENGINE: "PATTERN", LEARNING_ENGINE: "LEARNING" } as const;

/** Opaque candidate identity: family and structural keys only, never wording. */
export const candidateKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Z_]+(:[A-Za-z0-9._-]+)+$/, "CANDIDATE_KEY_FORMAT");

export type StoredEngineEvaluationAudit = {
  evaluationId: string;
  engine: "PATTERN" | "LEARNING";
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  runtimeManifestId: string;
  runtimeManifestVersion: string;
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  candidateKey: string;
  triggeringRevisions: TypedRevisionRef<RecordType>[];
  consideredRevisions: TypedRevisionRef<RecordType>[];
  inputFingerprint: Sha256Digest;
  resultFingerprint: Sha256Digest;
  dispositionKind: "RESULT" | "NO_CHANGE" | "CONTINUE_OBSERVING" | "SOURCE_NO_LONGER_ELIGIBLE";
  reasonCodes: EngineDecisionReasonCode[];
  limitationCodes: (typeof PATTERN_LIMITATION_CODES)[number][];
  proposedEffectKeys: string[];
};

const uniqueStrings = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).refine((values) => new Set(values).size === values.length, "DUPLICATE_VALUE");

export const engineEvaluationAuditRowSchema = z
  .strictObject({
    evaluationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    engine: z.enum(["PATTERN", "LEARNING"]),
    evaluatorKey: z.string().min(1).max(96),
    evaluatorVersion: z.string().min(1).max(32),
    configurationVersion: z.string().min(1).max(96),
    runtimeManifestId: z.string().min(1).max(96),
    runtimeManifestVersion: z.string().min(1).max(32),
    evaluatedAt: instantSchema,
    inputSequenceCutoff: z.number().int().nonnegative().safe(),
    candidateKey: candidateKeySchema,
    triggeringRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    consideredRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    inputFingerprint: sha256DigestSchema,
    resultFingerprint: sha256DigestSchema,
    dispositionKind: z.enum(["RESULT", "NO_CHANGE", "CONTINUE_OBSERVING", "SOURCE_NO_LONGER_ELIGIBLE"]),
    reasonCodes: uniqueStrings(z.enum(ENGINE_DECISION_REASON_CODES)),
    limitationCodes: uniqueStrings(z.enum(PATTERN_LIMITATION_CODES)),
    proposedEffectKeys: uniqueStrings(z.string().min(1).max(200)),
  })
  .superRefine((row, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const registration = REVERSE_DEPENDENCY_EVALUATORS[row.evaluatorKey];
    if (!registration || !registration.versions.includes(row.evaluatorVersion)) fail("UNKNOWN_EVALUATOR");
    else if (ENGINE_BY_OWNER[registration.owner] !== row.engine) fail("ENGINE_DISAGREES_WITH_EVALUATOR");
    if (!RUNTIME_MANIFESTS[row.runtimeManifestId]?.includes(row.runtimeManifestVersion)) fail("UNKNOWN_RUNTIME_MANIFEST");
  })
  .transform((row): StoredEngineEvaluationAudit => row as StoredEngineEvaluationAudit);
