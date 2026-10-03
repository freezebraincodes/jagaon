import { describe, expect, it } from "vitest";
import { reverseDependencyRowSchema, REVERSE_DEPENDENCY_EVALUATORS } from "./reverse-dependency-row";
import { engineEvaluationAuditRowSchema, ENGINE_DECISION_REASON_CODES } from "./engine-evaluation-audit-row";

const edge = {
  sourceRevisionId: "00000000-0000-4000-8000-000000000002",
  dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
  dependentRecordId: "00000000-0000-4000-8000-000000000008",
  dependentRevisionId: "00000000-0000-4000-8000-000000000009",
  dependencyRole: "RECENT_EVIDENCE",
  owner: "PATTERN_ENGINE",
  evaluatorKey: "pattern.comparable-slot-trend",
  evaluatorVersion: "7a.1",
  createdAt: "2026-09-30T10:00:00Z",
};

const audit = {
  evaluationId: "00000000-0000-4000-8000-00000000000a",
  engine: "PATTERN",
  evaluatorKey: "pattern.familiar-or-frequent-item",
  evaluatorVersion: "7a.1",
  configurationVersion: "familiar-or-frequent-item-config.v1",
  runtimeManifestId: "jagaon-hackathon-intelligence",
  runtimeManifestVersion: "7a.1",
  evaluatedAt: "2026-09-30T10:00:00Z",
  inputSequenceCutoff: 0,
  candidateKey: "FAMILIAR_OR_FREQUENT_ITEM:fik-abc:ORDINARY:RECURRING_IN_RECORDED_OCCASIONS",
  triggeringRevisions: [],
  consideredRevisions: [],
  inputFingerprint: "b".repeat(64),
  resultFingerprint: "c".repeat(64),
  dispositionKind: "RESULT",
  reasonCodes: ["PATTERN_OBSERVATION_CREATED"],
  limitationCodes: [],
  proposedEffectKeys: ["pattern:fik-abc"],
};

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("reverse-dependency rows", () => {
  it("registers exactly the three Packet 7A evaluators and the two Packet 8 dependency owners", () => {
    expect(Object.keys(REVERSE_DEPENDENCY_EVALUATORS)).toEqual([
      "pattern.comparable-slot-trend",
      "pattern.familiar-or-frequent-item",
      "learning.familiar-item",
      "inquiry.medication-occasion-barrier",
      "care-plan.reminder-target",
    ]);
  });

  it("accepts an exact edge and rejects unknown keys", () => {
    expect(ok(reverseDependencyRowSchema, edge)).toBe(true);
    expect(ok(reverseDependencyRowSchema, { ...edge, value: "7.2" })).toBe(false);
  });

  it("rejects unknown evaluators, versions and roles outside the evaluator registry", () => {
    expect(ok(reverseDependencyRowSchema, { ...edge, evaluatorKey: "pattern.routine-shift" })).toBe(false);
    expect(ok(reverseDependencyRowSchema, { ...edge, evaluatorVersion: "7b.1" })).toBe(false);
    expect(ok(reverseDependencyRowSchema, { ...edge, dependencyRole: "SUPPORTING_EVIDENCE" })).toBe(false);
    expect(ok(reverseDependencyRowSchema, { ...edge, dependencyRole: "ANYTHING" })).toBe(false);
  });

  it("requires the owner and dependent type that belong to the evaluator", () => {
    expect(ok(reverseDependencyRowSchema, { ...edge, owner: "LEARNING_ENGINE" })).toBe(false);
    expect(ok(reverseDependencyRowSchema, { ...edge, dependentRecordType: "LEARNED_KNOWLEDGE" })).toBe(false);
    expect(
      ok(reverseDependencyRowSchema, {
        ...edge,
        dependentRecordType: "LEARNED_KNOWLEDGE",
        owner: "LEARNING_ENGINE",
        evaluatorKey: "learning.familiar-item",
        dependencyRole: "SUPPORTING_EVIDENCE",
      }),
    ).toBe(true);
  });
});

describe("engine-evaluation audit rows", () => {
  it("accepts an exact audit without patient content", () => {
    expect(ok(engineEvaluationAuditRowSchema, audit)).toBe(true);
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, label: "Kaya toast" })).toBe(false);
  });

  it("rejects free-text candidate keys, unknown reasons and duplicate references", () => {
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, candidateKey: "Kaya toast at breakfast" })).toBe(false);
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, reasonCodes: ["SOMETHING_SEEMED_OFF"] })).toBe(false);
    const ref = { recordType: "INTAKE_EVENT", recordId: edge.dependentRecordId, revisionId: edge.dependentRevisionId };
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, consideredRevisions: [ref, ref] })).toBe(false);
  });

  it("keeps the engine, evaluator and manifest consistent", () => {
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, engine: "LEARNING" })).toBe(false);
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, engine: "SAFETY" })).toBe(false);
    expect(ok(engineEvaluationAuditRowSchema, { ...audit, runtimeManifestVersion: "7b.1" })).toBe(false);
  });

  it("lists a closed decision reason registry", () => {
    expect([...ENGINE_DECISION_REASON_CODES]).toEqual([
      "PATTERN_OBSERVATION_CREATED",
      "PATTERN_OBSERVATION_REVISED",
      "PATTERN_OBSERVATION_TRANSITIONED",
      "PATTERN_DERIVED_CONTENT_DELETED",
      "LEARNED_KNOWLEDGE_CREATED",
      "LEARNED_KNOWLEDGE_REVISED",
      "LEARNED_KNOWLEDGE_TRANSITIONED",
      "LEARNED_DERIVED_CONTENT_DELETED",
    ]);
  });
});
