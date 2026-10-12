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
 *   an owner sign-off (C1-c). Packet 11C English activation (owner decisions Q and A, 2026-10-12): the six en-SG classes of the current
 *   contract (three EXPLAIN_PATTERN, three DRAFT_CARE_PREPARATION_SUMMARY) are QUALIFIED by the owner's sign-off under the revised
 *   English demo protocol (evidenceRef names the protocol record). That sign-off is a WAIVER of the manual human review, not a completed
 *   human-review PASS: the recorded run verdict stays FAIL [HUMAN_REVIEW_PENDING, BLOCKED_CONTENT_REVIEW_PENDING]. The six zh-SG classes
 *   stay PENDING with no evidence, so every Chinese request (and any EXPLAIN_PATTERN request outside the three English classes) falls
 *   back to the deterministic composition before any disclosure or send. The one exception is the owner demo override (below, owner
 *   decision 2026-10-12): the SHIPPED gate also admits en-SG DRAFT_CARE_PREPARATION_SUMMARY requests outside the evaluated classes; it
 *   never sets QUALIFIED. No code path sets QUALIFIED: the records are a reviewed literal, never computed at runtime.
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
 * The SHIPPED qualification records: exactly one per generated definition. Moving a class to QUALIFIED is an owner sign-off (C1-c) under
 * this contract; it is never automatic. Packet 11C English activation (owner decisions Q and A, 2026-10-12): the six en-SG classes are
 * QUALIFIED (evidenceRef: the English demo protocol record, a waiver of the manual review, not a completed human-review PASS; signed off
 * by the JagaOn owner at 2026-10-11T18:13:14Z); the six zh-SG classes stay PENDING with no evidence and no sign-off.
 * CL3 re-freeze: the literal below is generated (renderQualificationRecordsBlock in packet-11c-request-class-generator.ts, PENDING unless
 * an owner sign-off record is passed in) and packet-11c-request-classes.test.ts requires byte equality with the owner sign-offs it pins;
 * the contract freeze pins the sha256 of this module OUTSIDE the literal.
 */
export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS: readonly AiRequestClassQualificationRecord[] = Object.freeze(
  ([
    { classId: "a00d8ad562619f605ca03fe406c18abe095410db4d6f53cca02f68601104910d", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "0c43de4a6cfb9eb6ec40c2ae13404c8f7664b127e864724452dbf0dc3f40a1f7", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "38ad0280e6382f4e3b314613b464bef0438ea6f6cc19cae2f41a10e0550e320d", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "c54c7d6754b5a791ab4e5732e82e6e9d8f4e235bd8004484db25f7f1558d9dac", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "e8fdbc6bbd7df5a90c2d9f395955d90bc1c8d6a41505c5b5f2019a9d335f49c4", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "2b3c472d0983bcff6364cfbd915ec026866a26f996608e8a55cbfa64d4cccc0d", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "5d0c75cef363c190e726f5cb055f4f9b6b265b76b7f8779b612467203ac6adca", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "37f7e95a9ff5436dbaab17b1bfefa57d132aaf7f407157c9d3cd2e3a39c9154f", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "8c3203f88db4567aa82a51d86967b845960f8f7f226591416c476c2ea670ec6b", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "QUALIFIED", evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
    { classId: "8de6bc4ed13d6ffac59be50a33ff31c7f0523e554f37173823ad0fc781e8643a", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "5763ae537e7b6e535115b92355e17a3f47cb4a239b0d75316559d19e35897b67", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
    { classId: "6a2e08dc46365327f1cfe34fa2f8aba3dd341d260b8b07de1ad90c2b9b889625", contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1", status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null },
  ] as const satisfies readonly AiRequestClassQualificationRecord[]).map((record): AiRequestClassQualificationRecord => Object.freeze({ ...record })),
);

export const SHIPPED_REQUEST_CLASS_REGISTRY: AiRequestClassRegistry = Object.freeze({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS });

/**
 * Owner demo override (owner decision 2026-10-12, confirmed in the owner's own words: "allow English AI care drafts for summaries that
 * were not in the tested shapes (owner demo override; History stays tested-only; Chinese stays off)"). The hackathon demo profile's care
 * summaries never match an evaluated care class, so an en-SG DRAFT_CARE_PREPARATION_SUMMARY request is admitted even when its class is
 * not QUALIFIED. Only the class gate is relaxed, and only for that task and locale: EXPLAIN_PATTERN stays qualified-only, every zh-SG
 * request stays refused, an unreadable request stays refused, and every other check is unchanged (value-blind request, the 32-fact cap
 * and the planner's wording budget, output validation and meaning rules, deterministic fallback, the disclosure, "Keep wording on this
 * device", the server switch, origin, access, spend and rate checks). Set `enabled` to false to return to tested shapes only.
 */
export const OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE = Object.freeze({
  enabled: true,
  decision: "owner decision 2026-10-12: English AI care drafts beyond the tested shapes (History stays tested-only; Chinese stays off)",
  taskType: "DRAFT_CARE_PREPARATION_SUMMARY" as const,
  locale: "en-SG" as const,
});
type OwnerDemoEnCareDraftOverride = Readonly<{ enabled: boolean; decision: string; taskType: ShellTask; locale: AiLocale }>;

/** Wraps a gate with the owner demo override: an en-SG care refusal with a computed class becomes an admission; all else passes through. */
export function withOwnerDemoEnCareDraftOverride(gate: AiRequestClassGate, override: OwnerDemoEnCareDraftOverride = OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE): AiRequestClassGate {
  if (!override.enabled) return gate;
  return Object.freeze({
    admit(request: ShellTaskRequest): AiRequestClassAdmission {
      const admission = gate.admit(request);
      if (admission.admitted || admission.classId === null) return admission;
      if (request.taskType !== override.taskType || request.locale !== override.locale) return admission;
      return Object.freeze({ admitted: true as const, classId: admission.classId });
    },
    anyAdmissible: (taskType: ShellTask): boolean => gate.anyAdmissible(taskType),
  });
}

/**
 * The production gate: the shipped definitions and records (the six en-SG classes are QUALIFIED; every zh-SG class is PENDING), with the
 * owner demo override for English care drafts (above).
 */
export const SHIPPED_REQUEST_CLASS_GATE: AiRequestClassGate = withOwnerDemoEnCareDraftOverride(createRequestClassGate(SHIPPED_REQUEST_CLASS_REGISTRY));
