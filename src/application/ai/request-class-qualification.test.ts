import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { projectShellTaskRequest } from "./language/shell-projector";
import { AI_REQUEST_CLASS_CONTRACT, AI_REQUEST_CLASS_DEFINITIONS } from "./request-class-definitions";
import {
  AI_REMOTE_ELIGIBILITY_POLICY_VERSION,
  AI_REQUEST_CLASS_QUALIFICATION_RECORDS,
  aiRequestClassQualificationRecordSchema,
  createRequestClassGate,
  requestClassId,
  requestClassIdentity,
  requestClassQualification,
  SHIPPED_REQUEST_CLASS_GATE,
  SHIPPED_REQUEST_CLASS_REGISTRY,
} from "./request-class-qualification";
import { qualifiedTestRequestClassGate, testDefinition, testQualifiedRecord, TEST_ONLY_QUALIFICATION } from "./request-class-test-support";

/** Packet 11C Addendum C, Task C1: separate, all-PENDING qualification records and the qualification rule. Offline; no provider. */

const ORDINARY = projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan);
const CARE = projectShellTaskRequest(plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary").plan);
const OTHER_CONTRACT = "0".repeat(64);
const definitionOf = (classId: string) => AI_REQUEST_CLASS_DEFINITIONS.find((definition) => definition.classId === classId);
const qualified = (classId: string, contractDigest = AI_REQUEST_CLASS_CONTRACT.digest) => ({ classId, contractDigest, status: "QUALIFIED", evidenceRef: "evidence/run-1", signedOffBy: "owner", signedOffAt: "2026-10-09T00:00:00.000Z" });
const pending = (classId: string) => ({ classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null });

describe("Packet 11C C1 qualification records (separate from the immutable definitions; shipped all PENDING)", () => {
  it("ships exactly one schema-valid PENDING record per definition, bound to the current contract, with no evidence or sign-off", () => {
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS).toHaveLength(AI_REQUEST_CLASS_DEFINITIONS.length);
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.classId)).toEqual(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId));
    for (const record of AI_REQUEST_CLASS_QUALIFICATION_RECORDS) {
      expect(aiRequestClassQualificationRecordSchema.parse(record)).toEqual(record);
      expect(record).toEqual({ classId: record.classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null });
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status !== "PENDING")).toEqual([]);
    expect(Object.isFrozen(AI_REQUEST_CLASS_QUALIFICATION_RECORDS)).toBe(true);
    expect(SHIPPED_REQUEST_CLASS_REGISTRY).toEqual({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS });
    expect(AI_REMOTE_ELIGIBILITY_POLICY_VERSION).toBe("ai-remote-eligibility.11c.1");
  });

  it("schema: QUALIFIED requires a non-empty evidence reference, signer and sign-off instant; PENDING carries no sign-off", () => {
    const id = AI_REQUEST_CLASS_DEFINITIONS[0]!.classId;
    expect(aiRequestClassQualificationRecordSchema.safeParse(qualified(id)).success).toBe(true);
    for (const change of [{ evidenceRef: null }, { signedOffBy: null }, { signedOffAt: null }, { evidenceRef: "" }, { signedOffBy: " owner" }, { signedOffAt: "yesterday" }, { extra: 1 }, { classId: "X" }, { contractDigest: "abc" }]) {
      expect(aiRequestClassQualificationRecordSchema.safeParse({ ...qualified(id), ...change }).success, JSON.stringify(change)).toBe(false);
    }
    expect(aiRequestClassQualificationRecordSchema.safeParse({ ...pending(id), evidenceRef: "evidence/run-1" }).success).toBe(true);
    expect(aiRequestClassQualificationRecordSchema.safeParse({ ...pending(id), signedOffBy: "owner" }).success).toBe(false);
    expect(aiRequestClassQualificationRecordSchema.safeParse({ ...pending(id), signedOffAt: "2026-10-09T00:00:00.000Z" }).success).toBe(false);
    expect(aiRequestClassQualificationRecordSchema.safeParse({ ...pending(id), status: "APPROVED" }).success).toBe(false);
  });

  it("class identity: the projected request's canonical digest bound to the current contract digest", () => {
    const identity = requestClassIdentity(ORDINARY);
    expect(identity.contractDigest).toBe(AI_REQUEST_CLASS_CONTRACT.digest);
    expect(identity.classId).toBe(requestClassId(AI_REQUEST_CLASS_CONTRACT.digest, identity.shellRequestDigest));
    expect(definitionOf(identity.classId)).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", shellRequestDigest: identity.shellRequestDigest });
    // The class does not depend on key order (canonical JSON) and changes with any request byte.
    const reordered = Object.fromEntries(Object.entries(ORDINARY).reverse()) as typeof ORDINARY;
    expect(requestClassIdentity(reordered).classId).toBe(identity.classId);
    expect(requestClassIdentity({ ...ORDINARY, fields: ORDINARY.fields.map((field, index) => (index === 0 ? { ...field, maxCodePoints: field.maxCodePoints - 1 } : field)) }).classId).not.toBe(identity.classId);
    expect(() => requestClassId("abc", identity.shellRequestDigest)).toThrow("REQUEST_CLASS_DIGEST_INVALID");
  });

  it("rule: only one schema-valid QUALIFIED record under the current contract, for a defined class, qualifies", () => {
    const identity = requestClassIdentity(ORDINARY);
    const definition = definitionOf(identity.classId);
    expect(requestClassQualification(identity, definition, [qualified(identity.classId)])).toEqual({ status: "QUALIFIED" });
    expect(requestClassQualification(identity, definition, [pending(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "PENDING" });
    expect(requestClassQualification(identity, definition, [])).toEqual({ status: "NOT_QUALIFIED", reason: "NO_RECORD" });
    expect(requestClassQualification(identity, definition, [qualified(identity.classId), qualified(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "SEVERAL_RECORDS" });
    // A record for another contract is invalid: treated as PENDING (not qualified), never as QUALIFIED.
    expect(requestClassQualification(identity, definition, [qualified(identity.classId, OTHER_CONTRACT)])).toEqual({ status: "NOT_QUALIFIED", reason: "CONTRACT_MISMATCH" });
    expect(requestClassQualification(identity, definition, [{ ...qualified(identity.classId), evidenceRef: null }])).toEqual({ status: "NOT_QUALIFIED", reason: "RECORD_INVALID" });
    expect(requestClassQualification(identity, definition, [qualified(AI_REQUEST_CLASS_DEFINITIONS[1]!.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "RECORD_INVALID" });
    expect(requestClassQualification(identity, undefined, [qualified(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "NO_DEFINITION" });
    expect(requestClassQualification(identity, { ...definition!, locale: "zh-SG" }, [qualified(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "NO_DEFINITION" });
    expect(requestClassQualification(identity, { ...definition!, contractDigest: OTHER_CONTRACT }, [qualified(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "NO_DEFINITION" });
    expect(requestClassQualification({ ...identity, contractDigest: OTHER_CONTRACT }, definition, [qualified(identity.classId)])).toEqual({ status: "NOT_QUALIFIED", reason: "CONTRACT_MISMATCH" });
  });

  it("the shipped gate admits no request of any defined class and reports no admissible task (nothing to disclose)", () => {
    for (const request of [ORDINARY, CARE]) {
      const admission = SHIPPED_REQUEST_CLASS_GATE.admit(request);
      expect(admission).toEqual({ admitted: false, classId: requestClassIdentity(request).classId, reason: "PENDING" });
    }
    expect(SHIPPED_REQUEST_CLASS_GATE.anyAdmissible("EXPLAIN_PATTERN")).toBe(false);
    expect(SHIPPED_REQUEST_CLASS_GATE.anyAdmissible("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(false);
    // An undefined class (e.g. a care request whose section counts differ from every evaluated class) is never admitted.
    const unseen = { ...CARE, fields: CARE.fields.slice(0, -1) };
    expect(SHIPPED_REQUEST_CLASS_GATE.admit(unseen)).toMatchObject({ admitted: false, reason: "NO_DEFINITION" });
    // Never throws: an unreadable request is not admitted.
    expect(SHIPPED_REQUEST_CLASS_GATE.admit({ ...ORDINARY, slots: undefined } as never)).toEqual({ admitted: false, classId: null, reason: "REQUEST_UNREADABLE" });
  });

  it("a registry with an owner QUALIFIED record admits exactly that class (and makes its task admissible)", () => {
    const id = requestClassIdentity(ORDINARY).classId;
    const gate = createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => (record.classId === id ? qualified(id) : record)) });
    expect(gate.admit(ORDINARY)).toEqual({ admitted: true, classId: id });
    expect(gate.admit(CARE)).toMatchObject({ admitted: false, reason: "PENDING" });
    expect(gate.anyAdmissible("EXPLAIN_PATTERN")).toBe(true);
    expect(gate.anyAdmissible("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(false);
    const stale = createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => (record.classId === id ? qualified(id, OTHER_CONTRACT) : record)) });
    expect(stale.admit(ORDINARY)).toMatchObject({ admitted: false, reason: "CONTRACT_MISMATCH" });
    expect(stale.anyAdmissible("EXPLAIN_PATTERN")).toBe(false);
  });

  it("test support: test-only QUALIFIED records go through the product rule and name the test, never evidence", () => {
    const gate = qualifiedTestRequestClassGate();
    const identity = requestClassIdentity(CARE);
    expect(gate.admit(CARE)).toEqual({ admitted: true, classId: identity.classId });
    expect(gate.admitted).toEqual([identity.classId]);
    expect(testQualifiedRecord(identity)).toEqual({ classId: identity.classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "QUALIFIED", ...TEST_ONLY_QUALIFICATION });
    expect(testDefinition(identity).sampleFixtureIds).toEqual([]);
    expect(TEST_ONLY_QUALIFICATION.evidenceRef).toMatch(/^TEST-ONLY/);
    expect(TEST_ONLY_QUALIFICATION.signedOffBy).toMatch(/^TEST-ONLY/);
  });

  it("no product code sets QUALIFIED and no product module imports the test support", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(process.cwd(), dir)).flatMap((name) => {
        const path = `${dir}/${name}`;
        return statSync(join(process.cwd(), path)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const sources = walk("src");
    const code = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(sources.filter((file) => /["']QUALIFIED["']/.test(code(file)))).toEqual(["src/application/ai/request-class-qualification.ts", "src/application/ai/request-class-test-support.ts"]);
    // In the product module, QUALIFIED appears only in the status list, the record schema and the rule (its result type and
    // comparisons), never in the shipped records literal.
    const product = code("src/application/ai/request-class-qualification.ts");
    const records = product.slice(product.indexOf("export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS"), product.indexOf("export const SHIPPED_REQUEST_CLASS_REGISTRY"));
    expect(records).toMatch(/"PENDING"/);
    expect(records).not.toMatch(/QUALIFIED["']/);
    // Only other test-support modules (themselves never in a production graph) may build on it.
    expect(sources.filter((file) => /request-class-test-support/.test(code(file)) && !/test-support\.ts$/.test(file))).toEqual([]);
    expect(sources.filter((file) => /request-class-test-support/.test(code(file)))).toEqual(["src/application/care-preparation/care-preparation-test-support.ts"]);
  });
});
