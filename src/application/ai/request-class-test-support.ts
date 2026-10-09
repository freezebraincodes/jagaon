import type { ShellTaskRequest } from "@/domain/ai";
import type { AiRequestClassDefinition } from "./request-class-definitions";
import { requestClassIdentity, requestClassQualification, type AiRequestClassAdmission, type AiRequestClassGate, type AiRequestClassIdentity, type AiRequestClassQualificationRecord } from "./request-class-qualification";

/**
 * TEST-ONLY (Packet 11C Addendum C, Task C1). Never imported by product code: the browser and route graphs exclude this module (pinned in
 * packet-11a-manifest.test.ts and request-class-qualification.test.ts). The shipped records stay all PENDING.
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
