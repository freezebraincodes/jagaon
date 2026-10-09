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
 * `anyAdmissible(task)` is a coarse task-level check: false when no class of that task is QUALIFIED, so no request of the task can be
 * sent. Packet 11C Addendum C (C3): the browser wiring no longer uses it for the disclosure; it admits each request with `admit` on that
 * request's own projected class (history: the request built for that comparison and locale; care: that preview's request).
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
 * CL3 re-freeze: the literal below is generated (renderQualificationRecordsBlock in packet-11c-request-class-generator.ts, all PENDING)
 * and packet-11c-request-classes.test.ts requires byte equality; the contract freeze pins the sha256 of this module OUTSIDE the literal.
 */
export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS: readonly AiRequestClassQualificationRecord[] = Object.freeze(
  ([
    { classId: "1fd8682f9820252af0d226be2c5fb29b83fe4cc165e66b271c708fb307748a91", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "008553947baeb03510015fb205d76d4e95111f2764848ccd9d03282afa91800a", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "e9ccdd241e60a5983d563584cc76268b3322dae434eb9026816db42e5fd51090", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "7c0feb2309a7d00d22b7d6042db6b03e07f454d5528e12850fdb8e8be621bd38", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "c71d85de04676942933ed5896b50f8bb10eee26913ef07c5f1b26a3d81da6e11", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "4bab2080371bbf5866acf3820cc4f9143210175b55bcd6835b0f45d6178f4b1a", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "49c4df9cee09fa626539e3a7a293813e1f692f7ed2ab22e3974b378b7265c3a4", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "c42bab1328df6df5fce42af123192a4306633c43487309b9b80568cdaf8e7d8f", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "ec871b8305f88a4bc4cb5891e6794435a69a4ad620d73b78d0806e5bf783cd70", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "41a6deffa183594fd695aa4eea0ec629856c84e46f3dad560205b6c8c1160215", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "90f58807bbf7dc539cba640582826adf68981bf81b5ef785c68110183c9be39b", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "c02605b03f1baae7f24d634e76dbc0c9bb707b41f7095ad6451666824b079f47", contractDigest: "30bb1549cbcdc31776316df36431718dc5f8683b9573c62491fd47e8261be971", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
  ] as const satisfies readonly AiRequestClassQualificationRecord[]).map((record): AiRequestClassQualificationRecord => Object.freeze({ ...record })),
);

export const SHIPPED_REQUEST_CLASS_REGISTRY: AiRequestClassRegistry = Object.freeze({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS });
/** The production gate: the shipped definitions and records (all PENDING, so nothing is admitted). */
export const SHIPPED_REQUEST_CLASS_GATE: AiRequestClassGate = createRequestClassGate(SHIPPED_REQUEST_CLASS_REGISTRY);
