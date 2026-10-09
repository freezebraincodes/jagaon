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
    { classId: "cb1925c0c9bc85c8dfa75648500df15c8cdc0f1f0774e4f7e7003dd30d8bfc87", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "87f33caaff876eaf6800f6bf52f00948f125a9a982e5e1f14e5b5f73f9011e21", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "81287a246ac1062109fece55825b9fb5f0c3d977db2940d9a8addd6d03143fab", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "818cfcf4b39e18ca069d0aad3ec286e83a6f9c7772704406e3755a8aa989ab9a", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "9cf93f92a646807e4ad1a214bb4c83d1e8d9c35fb43f15f773ee4fdf36409fee", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "82b4712365e0e0cbe2ac120e901e8b6f0d9db1ee3c732424935818b6416ec12e", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "2efcdd020da58dc5e92c8380273da5166a3cde584d3a5145f8e5f3ad56d3e859", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "14edfc1de07da9373750ad84ec0d423297a0d92a6e4fc1fb368b7496a723a934", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "5d577574638c5a7c08b6b943a9bff6baf52db2519998ebad9dc49e7565e60bfb", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "3acd8b2cd182434f92cdc29fc7accef2b2c3c54baf29241749de10b25a624a42", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "753e307f4e4175388d6978d310cf335c55a10902383671802ab41f7df90d1d39", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "a8c8095d082eeababc84fbc97fcd4fd438155aeeaaca453064a0982952b2ee44", contractDigest: "5bec1f2a7a27436456c6e8f348e66c6d7cfb051dce3782068b5ab71adc0437f8", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
  ] as const satisfies readonly AiRequestClassQualificationRecord[]).map((record): AiRequestClassQualificationRecord => Object.freeze({ ...record })),
);

export const SHIPPED_REQUEST_CLASS_REGISTRY: AiRequestClassRegistry = Object.freeze({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS });
/** The production gate: the shipped definitions and records (all PENDING, so nothing is admitted). */
export const SHIPPED_REQUEST_CLASS_GATE: AiRequestClassGate = createRequestClassGate(SHIPPED_REQUEST_CLASS_REGISTRY);
