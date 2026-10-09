import { z } from "zod";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { sha256Hex } from "@/application/intelligence/metrics";
import type { AiLocale, ShellTask, ShellTaskRequest } from "@/domain/ai";
import { AI_REQUEST_CLASS_CONTRACT, AI_REQUEST_CLASS_DEFINITIONS, type AiRequestClassDefinition } from "./request-class-definitions";

/**
 * Packet 11C Addendum C, Task C1 (owner approval of Addendum C, decision C1): remote eligibility is restricted to QUALIFIED request
 * classes. Browser-safe (no credential, prompt, provider or network code); shared by the browser hybrid service and the server route.
 *
 * - Class identity (`requestClassIdentity`): the canonical digest of the projected value-blind ShellTaskRequest (the bytes the route
 *   sends) bound to the frozen model-facing contract: classId = sha256(contractDigest || shellRequestDigest), with the contract digest of
 *   the generated, immutable `request-class-definitions.ts`. A changed contract changes every classId.
 * - Qualification records (`AI_REQUEST_CLASS_QUALIFICATION_RECORDS`, below): SEPARATE from the immutable definitions and mutable only by
 *   an owner sign-off (C1-c). Shipped ALL PENDING with no evidence: no class is qualified, so every request falls back to the
 *   deterministic composition before any disclosure or send. No code path sets QUALIFIED.
 * - The rule (`requestClassQualification`): a request is admitted only when its class is defined under the CURRENT contract and exactly
 *   one schema-valid record names it with status QUALIFIED and the current contract digest. Anything else (no definition, no record,
 *   several records, an invalid record, a record for another contract, PENDING) is NOT qualified: an invalid or stale record is treated as
 *   PENDING. Policy `ai-remote-eligibility.11c.1`; hybrid-full-policy.2 and its thresholds are unchanged, and no rule requires every
 *   sample of a class to be accepted. A class without accepted live evidence stays unqualified.
 * - The gate (`AiRequestClassGate`) is injected; production uses `SHIPPED_REQUEST_CLASS_GATE` (the shipped definitions and records).
 *   Tests that exercise a remote path inject a gate built from test-only QUALIFIED records (request-class-test-support.ts, never in a
 *   production graph). The evaluation harness, which gathers the evidence a class needs, admits its fixtures through its own
 *   evaluation-only gate.
 */
export const AI_REMOTE_ELIGIBILITY_POLICY_VERSION = "ai-remote-eligibility.11c.1";
export const AI_REQUEST_CLASS_QUALIFICATION_STATUSES = Object.freeze(["PENDING", "QUALIFIED"] as const);
export type AiRequestClassQualificationStatus = (typeof AI_REQUEST_CLASS_QUALIFICATION_STATUSES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(SHA256_HEX);
const referenceSchema = z.string().min(1).max(512).refine((value) => value.trim() === value && value.length > 0);
const instantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine((value) => !Number.isNaN(Date.parse(value)));

/**
 * One owner qualification record. PENDING records carry no sign-off (an evidence reference may be noted before sign-off); a QUALIFIED
 * record requires a non-empty evidence reference, the signer and the sign-off instant (schema-level).
 */
export const aiRequestClassQualificationRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ classId: digestSchema, contractDigest: digestSchema, status: z.literal("PENDING"), evidenceRef: referenceSchema.nullable(), signedOffBy: z.null(), signedOffAt: z.null() }),
  z.strictObject({ classId: digestSchema, contractDigest: digestSchema, status: z.literal("QUALIFIED"), evidenceRef: referenceSchema, signedOffBy: referenceSchema, signedOffAt: instantSchema }),
]);
export type AiRequestClassQualificationRecord = z.infer<typeof aiRequestClassQualificationRecordSchema>;

export type AiRequestClassIdentity = Readonly<{ classId: string; contractDigest: string; taskType: ShellTask; locale: AiLocale; shellRequestDigest: string }>;

/** sha256 of the canonical JSON (sorted keys, no whitespace) of the projected value-blind request. */
export function shellRequestDigest(request: ShellTaskRequest): string {
  return sha256Hex(canonicalizeJson(request));
}

/** classId = sha256(contractDigest || shellRequestDigest): the two 64-hex digests concatenated, hashed as UTF-8. */
export function requestClassId(contractDigest: string, requestDigest: string): string {
  if (!SHA256_HEX.test(contractDigest) || !SHA256_HEX.test(requestDigest)) throw new Error("REQUEST_CLASS_DIGEST_INVALID");
  return sha256Hex(`${contractDigest}${requestDigest}`);
}

/** The class identity of a projected value-blind request under the CURRENT contract. */
export function requestClassIdentity(request: ShellTaskRequest): AiRequestClassIdentity {
  const contractDigest = AI_REQUEST_CLASS_CONTRACT.digest;
  const requestDigest = shellRequestDigest(request);
  return Object.freeze({ classId: requestClassId(contractDigest, requestDigest), contractDigest, taskType: request.taskType, locale: request.locale, shellRequestDigest: requestDigest });
}

export type AiRequestClassNotQualifiedReason = "NO_DEFINITION" | "NO_RECORD" | "SEVERAL_RECORDS" | "RECORD_INVALID" | "CONTRACT_MISMATCH" | "PENDING";
export type AiRequestClassQualification = Readonly<{ status: "QUALIFIED" }> | Readonly<{ status: "NOT_QUALIFIED"; reason: AiRequestClassNotQualifiedReason }>;

/**
 * The qualification of one class identity, given its definition (if any) and every record naming its classId. Only an identity under
 * the current contract, matched exactly by its definition and by exactly one schema-valid QUALIFIED record for the current contract,
 * is QUALIFIED.
 */
export function requestClassQualification(identity: AiRequestClassIdentity, definition: AiRequestClassDefinition | undefined, records: readonly unknown[]): AiRequestClassQualification {
  const current = AI_REQUEST_CLASS_CONTRACT.digest;
  const notQualified = (reason: AiRequestClassNotQualifiedReason): AiRequestClassQualification => Object.freeze({ status: "NOT_QUALIFIED" as const, reason });
  if (identity.contractDigest !== current) return notQualified("CONTRACT_MISMATCH");
  if (
    definition === undefined ||
    definition.classId !== identity.classId ||
    definition.contractDigest !== current ||
    definition.taskType !== identity.taskType ||
    definition.locale !== identity.locale ||
    definition.shellRequestDigest !== identity.shellRequestDigest ||
    requestClassId(definition.contractDigest, definition.shellRequestDigest) !== definition.classId
  ) {
    return notQualified("NO_DEFINITION");
  }
  if (records.length === 0) return notQualified("NO_RECORD");
  if (records.length > 1) return notQualified("SEVERAL_RECORDS");
  const parsed = aiRequestClassQualificationRecordSchema.safeParse(records[0]);
  if (!parsed.success || parsed.data.classId !== identity.classId) return notQualified("RECORD_INVALID");
  if (parsed.data.contractDigest !== current) return notQualified("CONTRACT_MISMATCH");
  return parsed.data.status === "QUALIFIED" ? Object.freeze({ status: "QUALIFIED" as const }) : notQualified("PENDING");
}

export type AiRequestClassAdmission = Readonly<{ admitted: true; classId: string }> | Readonly<{ admitted: false; classId: string | null; reason: AiRequestClassNotQualifiedReason | "REQUEST_UNREADABLE" }>;
/**
 * Decides whether a projected value-blind request may be sent. `admit` never throws (an unreadable request is not admitted).
 * `anyAdmissible(task)` is a coarse check for the disclosure: false when no class of that task is QUALIFIED, so no request of the task
 * can be sent and there is nothing to disclose.
 */
export type AiRequestClassGate = Readonly<{ admit(request: ShellTaskRequest): AiRequestClassAdmission; anyAdmissible(taskType: ShellTask): boolean }>;
export type AiRequestClassRegistry = Readonly<{ definitions: readonly AiRequestClassDefinition[]; records: readonly unknown[] }>;

const recordClassId = (record: unknown): unknown => (record !== null && typeof record === "object" ? (record as { classId?: unknown }).classId : undefined);

/** A gate over a registry of definitions and qualification records. */
export function createRequestClassGate(registry: AiRequestClassRegistry): AiRequestClassGate {
  const qualificationOf = (identity: AiRequestClassIdentity) =>
    requestClassQualification(
      identity,
      registry.definitions.find((definition) => definition.classId === identity.classId),
      registry.records.filter((record) => recordClassId(record) === identity.classId),
    );
  return Object.freeze({
    admit(request: ShellTaskRequest): AiRequestClassAdmission {
      let identity: AiRequestClassIdentity;
      try {
        identity = requestClassIdentity(request);
      } catch {
        return Object.freeze({ admitted: false as const, classId: null, reason: "REQUEST_UNREADABLE" as const });
      }
      const qualification = qualificationOf(identity);
      return qualification.status === "QUALIFIED" ? Object.freeze({ admitted: true as const, classId: identity.classId }) : Object.freeze({ admitted: false as const, classId: identity.classId, reason: qualification.reason });
    },
    anyAdmissible(taskType: ShellTask): boolean {
      return registry.definitions.some((definition) => definition.taskType === taskType && qualificationOf(definition).status === "QUALIFIED");
    },
  });
}

/**
 * The SHIPPED qualification records: exactly one per generated definition, every one PENDING with no evidence and no sign-off. Moving a
 * class to QUALIFIED is an owner sign-off (C1-c) after accepted live evidence under this contract; it is never automatic.
 */
export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS: readonly AiRequestClassQualificationRecord[] = Object.freeze(
  ([
    { classId: "bac882e227c2d60c1fc3d5e8254e2156d1799292d75e61ac3de049ac71a6700f", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "485a2775305fc15df24f8b4875480d25c68f22404bd7b3770ffc7568dd4805c9", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "a6df9a141604ab110a711da6fc6633039e5e996f11a446ad6786c56730cce046", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "21095e8b492b28f3e42e5d4c8a41e798850f31af57b5adb32fb1e145de6b44d6", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "d730024d1739e62b4b41dbf4359ba777eb298f8c77f9f3c9df02aff0833f554d", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "fdbcd2b97549ef30f4cacb3949fd62f6305c7239e7c04dde5490dbb539b90b24", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "aeabdaa95f6a7dc055f7fe737f41553459d9e25402665f99bea1251da7bd0b73", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "dd7bbe0996b20441c9f6265fd1d26fbd6307ed7df3f315fa3bd090d6f5fd3316", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "dd2a66a29ac985b7339106db3b5d6a1ef4ca17cd2bf92ca37750ef08262a3483", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "46fdc1a51c13432b4fa7392a88fec88814b0ecc82c1e71bb79be421b5c7e0965", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "430e29a5637992267da2c3e839aaa1abeee5a5f5c7d58680af8eff56119952f7", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "7634c87ff2d343f23d4f59a56d0f1a693d32cab329167ce7bc614f1c50994edd", contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
  ] as const satisfies readonly AiRequestClassQualificationRecord[]).map((record): AiRequestClassQualificationRecord => Object.freeze({ ...record })),
);

export const SHIPPED_REQUEST_CLASS_REGISTRY: AiRequestClassRegistry = Object.freeze({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS });
/** The production gate: the shipped definitions and records (all PENDING, so nothing is admitted). */
export const SHIPPED_REQUEST_CLASS_GATE: AiRequestClassGate = createRequestClassGate(SHIPPED_REQUEST_CLASS_REGISTRY);
