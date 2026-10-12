import type { AiTaskType, ShellTaskRequest } from "@/domain/ai";
import { AI_DETERMINISTIC_ONLY_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { AI_REQUEST_CLASS_DEFINITIONS, type AiRequestClassDefinition } from "./request-class-definitions";
import {
  createRequestClassGate,
  requestClassIdentity,
  requestClassQualification,
  type AiRequestClassAdmission,
  type AiRequestClassGate,
  type AiRequestClassIdentity,
  type AiRequestClassQualificationRecord,
} from "./request-class-qualification";

/**
 * TEST-ONLY (Packet 11C Addendum C, Task C1). Never imported by product code: the browser and route graphs exclude this module (pinned in
 * packet-11a-manifest.test.ts and request-class-qualification.test.ts). Packet 11C English activation (owner decisions Q and A,
 * 2026-10-12): the shipped records QUALIFY the six en-SG classes (zh-SG stays PENDING) and the shipped manifest enables EXPLAIN_PATTERN and
 * DRAFT_CARE_PREPARATION_SUMMARY, so the shipped state is no longer an "unqualified" or "not activated" fixture. Tests whose subject is
 * an unqualified class or a task that is not activated inject `pendingTestRequestClassGate()` or `DETERMINISTIC_ONLY_TEST_MANIFEST`
 * (below; the pre-activation shipped state, rebuilt here) instead of relying on the shipped defaults.
 *
 * Tests that exercise a remote path inject `qualifiedTestRequestClassGate()` through the existing test seams (the hybrid service, the
 * browser wiring and the shell route each take an optional `requestClassGate`, defaulting to the shipped gate). The gate gives every class
 * it sees a test-only definition and ONE test-only QUALIFIED record under the current contract, and decides through the product rule
 * (`requestClassQualification`), so the record still has to be schema-valid and bound to the current contract. It records the class ids
 * it admitted. The evidence reference and signer name the test; they are never evidence or a sign-off.
 */
export const TEST_ONLY_QUALIFICATION = Object.freeze({ evidenceRef: "TEST-ONLY: not evidence", signedOffBy: "TEST-ONLY: not a sign-off", signedOffAt: "2026-10-08T00:00:00.000Z" });

export function testQualifiedRecord(identity: AiRequestClassIdentity): AiRequestClassQualificationRecord {
  return { classId: identity.classId, contractDigest: identity.contractDigest, status: "QUALIFIED", ...TEST_ONLY_QUALIFICATION };
}

export function testDefinition(identity: AiRequestClassIdentity): AiRequestClassDefinition {
  return { classId: identity.classId, contractDigest: identity.contractDigest, taskType: identity.taskType, locale: identity.locale, shellRequestDigest: identity.shellRequestDigest, sampleFixtureIds: [] };
}

export type TestRequestClassGate = AiRequestClassGate & Readonly<{ admitted: readonly string[] }>;

/** A gate qualifying every class it sees with a test-only record. */
export function qualifiedTestRequestClassGate(): TestRequestClassGate {
  const admitted: string[] = [];
  return {
    admitted,
    admit(request: ShellTaskRequest): AiRequestClassAdmission {
      const identity = requestClassIdentity(request);
      const qualification = requestClassQualification(identity, testDefinition(identity), [testQualifiedRecord(identity)]);
      if (qualification.status !== "QUALIFIED") return { admitted: false, classId: identity.classId, reason: qualification.reason };
      admitted.push(identity.classId);
      return { admitted: true, classId: identity.classId };
    },
    anyAdmissible: () => true,
  };
}

/**
 * The shipped gate's definitions with every record PENDING (no evidence, no sign-off): the shipped state before the Packet 11C English
 * activation. Decides through the product gate (`createRequestClassGate`), so nothing is admitted.
 */
export function pendingTestRequestClassGate(): AiRequestClassGate {
  return createRequestClassGate({
    definitions: AI_REQUEST_CLASS_DEFINITIONS,
    records: AI_REQUEST_CLASS_DEFINITIONS.map((definition) => ({ classId: definition.classId, contractDigest: definition.contractDigest, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null })),
  });
}

/**
 * The activation manifest before the Packet 11C English activation (`ai-activation.11a.1`: every task DETERMINISTIC_ONLY under
 * HACKATHON_DEMO), for tests whose subject is a task that is not activated, and as the base of a test manifest that enables exactly the
 * tasks it names (`testManifestEnabling`). The same object as the production constant `AI_DETERMINISTIC_ONLY_MANIFEST` (the legacy 11A
 * service's default).
 */
export const DETERMINISTIC_ONLY_TEST_MANIFEST: AiActivationManifest = AI_DETERMINISTIC_ONLY_MANIFEST;

/** A test manifest with exactly the named tasks SYNTHETIC_REMOTE_ENABLED and every other task DETERMINISTIC_ONLY. */
export function testManifestEnabling(...taskTypes: AiTaskType[]): AiActivationManifest {
  return { ...DETERMINISTIC_ONLY_TEST_MANIFEST, tasks: { ...DETERMINISTIC_ONLY_TEST_MANIFEST.tasks, ...Object.fromEntries(taskTypes.map((taskType) => [taskType, "SYNTHETIC_REMOTE_ENABLED"])) } };
}
