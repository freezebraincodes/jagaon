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
  OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE,
  requestClassId,
  requestClassIdentity,
  requestClassQualification,
  SHIPPED_REQUEST_CLASS_GATE,
  SHIPPED_REQUEST_CLASS_REGISTRY,
  withOwnerDemoEnCareDraftOverride,
} from "./request-class-qualification";
import { pendingTestRequestClassGate, qualifiedTestRequestClassGate, testDefinition, testQualifiedRecord, TEST_ONLY_QUALIFICATION } from "./request-class-test-support";

/**
 * Packet 11C Addendum C, Task C1: separate qualification records and the qualification rule. Offline; no provider.
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12): the shipped records QUALIFY exactly the six en-SG classes (owner
 * sign-off under the revised English demo protocol: a waiver of the manual review, not a completed human-review PASS); the six zh-SG
 * classes stay PENDING with no evidence and no sign-off. The rule and the gate are unchanged.
 */

const ORDINARY = projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan);
const CARE = projectShellTaskRequest(plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary").plan);
const OTHER_CONTRACT = "0".repeat(64);
const definitionOf = (classId: string) => AI_REQUEST_CLASS_DEFINITIONS.find((definition) => definition.classId === classId);
const qualified = (classId: string, contractDigest = AI_REQUEST_CLASS_CONTRACT.digest) => ({ classId, contractDigest, status: "QUALIFIED", evidenceRef: "evidence/run-1", signedOffBy: "owner", signedOffAt: "2026-10-09T00:00:00.000Z" });
const pending = (classId: string) => ({ classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null });
/** The owner's sign-off (decision Q): exactly these six en-SG classes, with exactly these fields. */
const EN_QUALIFIED_CLASS_IDS = [
  "a00d8ad562619f605ca03fe406c18abe095410db4d6f53cca02f68601104910d",
  "0c43de4a6cfb9eb6ec40c2ae13404c8f7664b127e864724452dbf0dc3f40a1f7",
  "38ad0280e6382f4e3b314613b464bef0438ea6f6cc19cae2f41a10e0550e320d",
  "5d0c75cef363c190e726f5cb055f4f9b6b265b76b7f8779b612467203ac6adca",
  "37f7e95a9ff5436dbaab17b1bfefa57d132aaf7f407157c9d3cd2e3a39c9154f",
  "8c3203f88db4567aa82a51d86967b845960f8f7f226591416c476c2ea670ec6b",
];
const OWNER_SIGN_OFF = { evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" };
/** The first sample fixture's projected request of a definition (every sample of a class projects to the same request). */
const sampleRequest = (classId: string) => projectShellTaskRequest(plannedFixture(definitionOf(classId)!.sampleFixtureIds[0]!).plan);
const ALL_PENDING_RECORDS = AI_REQUEST_CLASS_DEFINITIONS.map((definition) => pending(definition.classId));

describe("Packet 11C C1 qualification records (separate from the immutable definitions; shipped: six en-SG QUALIFIED, six zh-SG PENDING)", () => {
  it("ships exactly one schema-valid record per definition, bound to the current contract: the six en-SG classes QUALIFIED by the owner's sign-off, the six zh-SG classes PENDING with no evidence or sign-off", () => {
    expect(AI_REQUEST_CLASS_CONTRACT.digest).toBe("4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1");
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS).toHaveLength(AI_REQUEST_CLASS_DEFINITIONS.length);
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.classId)).toEqual(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId));
    for (const record of AI_REQUEST_CLASS_QUALIFICATION_RECORDS) {
      expect(aiRequestClassQualificationRecordSchema.parse(record)).toEqual(record);
      const definition = definitionOf(record.classId)!;
      if (definition.locale === "en-SG") {
        expect(record).toEqual({ classId: record.classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "QUALIFIED", ...OWNER_SIGN_OFF });
      } else {
        expect(definition.locale).toBe("zh-SG");
        expect(record).toEqual({ classId: record.classId, contractDigest: AI_REQUEST_CLASS_CONTRACT.digest, status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null });
      }
      expect(Object.isFrozen(record)).toBe(true);
    }
    // Exactly the six owner-signed en-SG classes (three per task) are QUALIFIED; every zh-SG class is PENDING.
    const qualifiedRecords = AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "QUALIFIED");
    expect(qualifiedRecords.map((record) => record.classId)).toEqual(EN_QUALIFIED_CLASS_IDS);
    expect(qualifiedRecords.map((record) => [definitionOf(record.classId)!.taskType, definitionOf(record.classId)!.locale])).toEqual([
      ["EXPLAIN_PATTERN", "en-SG"], ["EXPLAIN_PATTERN", "en-SG"], ["EXPLAIN_PATTERN", "en-SG"],
      ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"],
    ]);
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "PENDING").map((record) => definitionOf(record.classId)!.locale)).toEqual(Array(6).fill("zh-SG"));
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

  it("the shipped gate admits a request of each en-SG class and of no zh-SG class (PENDING); both tasks are admissible", () => {
    for (const definition of AI_REQUEST_CLASS_DEFINITIONS) {
      const request = sampleRequest(definition.classId);
      expect(requestClassIdentity(request).classId).toBe(definition.classId);
      expect(SHIPPED_REQUEST_CLASS_GATE.admit(request), definition.classId).toEqual(
        definition.locale === "en-SG" ? { admitted: true, classId: definition.classId } : { admitted: false, classId: definition.classId, reason: "PENDING" },
      );
    }
    expect(SHIPPED_REQUEST_CLASS_GATE.admit(ORDINARY)).toEqual({ admitted: true, classId: EN_QUALIFIED_CLASS_IDS[0] });
    expect(SHIPPED_REQUEST_CLASS_GATE.admit(CARE)).toEqual({ admitted: false, classId: requestClassIdentity(CARE).classId, reason: "PENDING" });
    expect(SHIPPED_REQUEST_CLASS_GATE.anyAdmissible("EXPLAIN_PATTERN")).toBe(true);
    expect(SHIPPED_REQUEST_CLASS_GATE.anyAdmissible("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(true);
    // The pre-activation state (every record PENDING) admits nothing and reports no admissible task.
    const pendingGate = pendingTestRequestClassGate();
    for (const request of [ORDINARY, CARE]) expect(pendingGate.admit(request)).toEqual({ admitted: false, classId: requestClassIdentity(request).classId, reason: "PENDING" });
    expect(pendingGate.anyAdmissible("EXPLAIN_PATTERN")).toBe(false);
    expect(pendingGate.anyAdmissible("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(false);
    // An undefined class (e.g. a care request whose section counts differ from every evaluated class) is never admitted.
    const unseen = { ...CARE, fields: CARE.fields.slice(0, -1) };
    expect(SHIPPED_REQUEST_CLASS_GATE.admit(unseen)).toMatchObject({ admitted: false, reason: "NO_DEFINITION" });
    // Never throws: an unreadable request is not admitted.
    expect(SHIPPED_REQUEST_CLASS_GATE.admit({ ...ORDINARY, slots: undefined } as never)).toEqual({ admitted: false, classId: null, reason: "REQUEST_UNREADABLE" });
  });

  describe("owner demo override (owner decision 2026-10-12): English AI care drafts beyond the tested shapes", () => {
    const EN_CARE = projectShellTaskRequest(plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary").plan);
    const unseenEnCare = { ...EN_CARE, fields: EN_CARE.fields.slice(0, -1) };
    const unseenZhCare = { ...CARE, fields: CARE.fields.slice(0, -1) };
    const unseenEnExplain = { ...ORDINARY, fields: ORDINARY.fields.slice(0, -1) };

    it("is one explicit switch: enabled, English care drafts only", () => {
      expect(OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE).toEqual({
        enabled: true,
        decision: "owner decision 2026-10-12: English AI care drafts beyond the tested shapes (History stays tested-only; Chinese stays off)",
        taskType: "DRAFT_CARE_PREPARATION_SUMMARY",
        locale: "en-SG",
      });
      expect(Object.isFrozen(OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE)).toBe(true);
    });

    it("the shipped gate admits an en-SG care request of an untested class, and still refuses zh-SG care and an untested en-SG explanation", () => {
      expect(requestClassIdentity(unseenEnCare).locale).toBe("en-SG");
      expect(SHIPPED_REQUEST_CLASS_GATE.admit(unseenEnCare)).toEqual({ admitted: true, classId: requestClassIdentity(unseenEnCare).classId });
      expect(SHIPPED_REQUEST_CLASS_GATE.admit(unseenZhCare)).toMatchObject({ admitted: false, reason: "NO_DEFINITION" });
      expect(SHIPPED_REQUEST_CLASS_GATE.admit(CARE)).toMatchObject({ admitted: false, reason: "PENDING" });
      expect(SHIPPED_REQUEST_CLASS_GATE.admit(unseenEnExplain)).toMatchObject({ admitted: false, reason: "NO_DEFINITION" });
    });

    it("the wrapper only turns an en-SG care refusal into an admission; everything else passes through unchanged", () => {
      const pendingGate = pendingTestRequestClassGate();
      const wrapped = withOwnerDemoEnCareDraftOverride(pendingGate);
      expect(wrapped.admit(EN_CARE)).toEqual({ admitted: true, classId: requestClassIdentity(EN_CARE).classId });
      expect(wrapped.admit(CARE)).toEqual(pendingGate.admit(CARE));
      expect(wrapped.admit(ORDINARY)).toEqual(pendingGate.admit(ORDINARY));
      // An unreadable request stays refused (no class can be computed).
      expect(wrapped.admit({ ...EN_CARE, slots: undefined } as never)).toEqual({ admitted: false, classId: null, reason: "REQUEST_UNREADABLE" });
      expect(wrapped.anyAdmissible("EXPLAIN_PATTERN")).toBe(pendingGate.anyAdmissible("EXPLAIN_PATTERN"));
      // Disabled: the wrapped gate is returned as is.
      expect(withOwnerDemoEnCareDraftOverride(pendingGate, { ...OWNER_DEMO_EN_CARE_DRAFT_OVERRIDE, enabled: false })).toBe(pendingGate);
    });
  });

  it("a registry with an owner QUALIFIED record admits exactly that class (and makes its task admissible)", () => {
    const id = requestClassIdentity(ORDINARY).classId;
    // Over the pre-activation records (all PENDING), so that the one owner record is the only QUALIFIED one.
    const gate = createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: ALL_PENDING_RECORDS.map((record) => (record.classId === id ? qualified(id) : record)) });
    expect(gate.admit(ORDINARY)).toEqual({ admitted: true, classId: id });
    expect(gate.admit(CARE)).toMatchObject({ admitted: false, reason: "PENDING" });
    expect(gate.anyAdmissible("EXPLAIN_PATTERN")).toBe(true);
    expect(gate.anyAdmissible("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(false);
    const stale = createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: ALL_PENDING_RECORDS.map((record) => (record.classId === id ? qualified(id, OTHER_CONTRACT) : record)) });
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
    // comparisons), and in the shipped records literal on exactly the six owner-signed en-SG records (Packet 11C English activation,
    // owner decisions Q and A); it is never computed.
    const product = code("src/application/ai/request-class-qualification.ts");
    const records = product.slice(product.indexOf("export const AI_REQUEST_CLASS_QUALIFICATION_RECORDS"), product.indexOf("export const SHIPPED_REQUEST_CLASS_REGISTRY"));
    expect(records.match(/"PENDING"/g)).toHaveLength(6);
    expect(records.match(/QUALIFIED["']/g)).toHaveLength(6);
    expect(records.split("\n").filter((line) => /"QUALIFIED"/.test(line)).map((line) => /classId: "([0-9a-f]{64})"/.exec(line)?.[1])).toEqual(EN_QUALIFIED_CLASS_IDS);
    // Outside the literal: the same seven occurrences as before the activation (status list, schema, rule); the rule is unchanged.
    expect(product.replace(records, "").match(/["']QUALIFIED["']/g)).toHaveLength(7);
    // Only other test-support modules (themselves never in a production graph) may build on it.
    expect(sources.filter((file) => /request-class-test-support/.test(code(file)) && !/test-support\.ts$/.test(file))).toEqual([]);
    expect(sources.filter((file) => /request-class-test-support/.test(code(file)))).toEqual(["src/application/care-preparation/care-preparation-test-support.ts"]);
  });
});
