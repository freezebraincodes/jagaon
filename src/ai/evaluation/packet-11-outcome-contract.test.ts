import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { normaliseProviderEnvelope } from "@/ai/kie/kie-responses-contracts";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";
import { diagnoseSchemaFailure } from "./packet-11-schema-diagnostics";

/**
 * Exclusive outcome contract (owner instruction 2026-10-06). The packet11-eval.3 FULL run's first call on
 * p11.explain-pattern.en-sg.abstention returned outcome SUCCESS with payload null and abstentionReason null:
 * the provider JSON schema lets payload and abstentionReason each be null independently, and prompt 11b.9
 * never said SUCCESS needs a payload. These tests pin that the unchanged validator rejects every mixed
 * combination as SCHEMA_INVALID (no automatic rewrite), accepts SUCCESS with a payload, and records a
 * well-formed ABSTAIN as MODEL_ABSTAINED. They guard existing behaviour.
 */

type Raw = Record<string, any>;
const ORDINARY = ["en-SG", "zh-SG"].flatMap((locale) => ["explain-pattern", "draft-care-preparation-summary"].map((task) => PACKET_11_FIXTURES.find((fixture) => fixture.id === `p11.${task}.${locale.toLowerCase()}.ordinary`)!));
const CASES = ORDINARY.map((fixture) => [fixture.id, fixture] as const);

function success(fixture: AiEvaluationFixture): Raw {
  const output = structuredClone(outputFixture(fixture.taskType)) as Raw;
  output.locale = fixture.locale;
  if (fixture.locale === "zh-SG") {
    if (fixture.taskType === "EXPLAIN_PATTERN") {
      output.payload.headline.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
      output.payload.observation.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
      output.payload.evidence.text = "这使用了 10 个已记录的读数。";
    } else {
      output.payload.sections[0].bullets[0].text = "记录了一个 6.2 mmol/L 的读数。";
      output.payload.sections[1].bullets[0].text = (fixture.request.facts as Array<{ ref: string; value: { text?: string } }>).find((fact) => fact.ref === "fact-2")!.value.text;
    }
  }
  return { ...output, abstentionReason: null };
}
const validate = (fixture: AiEvaluationFixture, raw: Raw) => validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType], normaliseProviderEnvelope(raw));
const schemaInvalid = { kind: "REJECTED", reason: "SCHEMA_INVALID" };

describe("controls", () => {
  it.each(CASES)("%s: SUCCESS with a complete payload and abstentionReason null is accepted", (_id, fixture) => {
    expect(validate(fixture, success(fixture))).toMatchObject({ kind: "ACCEPTED" });
  });
  it.each(CASES)("%s: ABSTAIN with payload null and an allowed abstentionReason is a recorded abstention, not a schema failure", (_id, fixture) => {
    expect(validate(fixture, { ...success(fixture), outcome: "ABSTAIN", payload: null, abstentionReason: "INSUFFICIENT_CONTEXT", inputRefsUsed: [] })).toMatchObject({ kind: "REJECTED", reason: "MODEL_ABSTAINED" });
  });
});

describe("every mixed outcome combination is SCHEMA_INVALID", () => {
  it.each(CASES)("%s: SUCCESS with payload null and abstentionReason null (the stored eval.3 shape)", (_id, fixture) => {
    const raw = { ...success(fixture), payload: null };
    expect(validate(fixture, raw)).toMatchObject(schemaInvalid);
    expect(diagnoseSchemaFailure(fixture, normaliseProviderEnvelope(raw))?.findings).toEqual([{ category: "REQUIRED_FIELD_MISSING", path: "payload", rule: "required", count: 1, boundary: null }]);
  });
  it.each(CASES)("%s: SUCCESS with a payload and a non-null abstentionReason", (_id, fixture) => {
    expect(validate(fixture, { ...success(fixture), abstentionReason: "INSUFFICIENT_CONTEXT" })).toMatchObject(schemaInvalid);
  });
  it.each(CASES)("%s: ABSTAIN with a payload", (_id, fixture) => {
    expect(validate(fixture, { ...success(fixture), outcome: "ABSTAIN", abstentionReason: "INSUFFICIENT_CONTEXT" })).toMatchObject(schemaInvalid);
  });
  it.each(CASES)("%s: ABSTAIN with payload null and abstentionReason null", (_id, fixture) => {
    expect(validate(fixture, { ...success(fixture), outcome: "ABSTAIN", payload: null, abstentionReason: null, inputRefsUsed: [] })).toMatchObject(schemaInvalid);
  });
  it.each(CASES)("%s: ABSTAIN with an abstentionReason outside the allowlist", (_id, fixture) => {
    expect(validate(fixture, { ...success(fixture), outcome: "ABSTAIN", payload: null, abstentionReason: "NOT_A_REASON", inputRefsUsed: [] })).toMatchObject(schemaInvalid);
  });
});
