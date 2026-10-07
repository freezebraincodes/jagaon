import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { aiTaskOutputSchema, aiTaskOutputVariantSchema } from "@/domain/ai";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { fixturesForPhase, type AiEvaluationFixture } from "./packet-11-fixtures";
import { diagnoseSchemaFailure, SCHEMA_DIAGNOSTIC_CATEGORIES } from "./packet-11-schema-diagnostics";

/** Packet 11B Phase 1: offline, evaluation-only schema-failure diagnostic (owner instruction 2026-10-06). */

const EXPLAIN = fixturesForPhase("SMOKE")[0]!;
const CARE = fixturesForPhase("SMOKE")[2]!;
const explain = (): Record<string, any> => ({ ...(structuredClone(outputFixture("EXPLAIN_PATTERN")) as object), inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"] });
const care = (): Record<string, any> => structuredClone(outputFixture("DRAFT_CARE_PREPARATION_SUMMARY")) as Record<string, any>;
const validate = (fixture: AiEvaluationFixture, output: unknown) => validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType], output);
const findingsOf = (fixture: AiEvaluationFixture, output: unknown) => diagnoseSchemaFailure(fixture, output)?.findings ?? null;
const HOSTILE = ["S1234567D", "sk-live-0123456789abcdef0123456789", "Tan Ah Kow", "Blk 123 #04-56", "9.9 mmol/L", "<script>", "\u0000"];

afterEach(() => vi.restoreAllMocks());

describe("contract variants", () => {
  it("exposes the exact SUCCESS/ABSTAIN variant objects of the unchanged 11A union", () => {
    const options = (aiTaskOutputSchema as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options;
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      for (const outcome of ["SUCCESS", "ABSTAIN"] as const) expect(options).toContain(aiTaskOutputVariantSchema(task, outcome));
    }
    expect(options).toHaveLength(12);
  });
});

describe("closed schema-failure categories", () => {
  it("are exactly the repository-grounded categories", () => {
    expect(SCHEMA_DIAGNOSTIC_CATEGORIES).toEqual([
      "ROOT_TYPE_INVALID",
      "REQUIRED_FIELD_MISSING",
      "UNKNOWN_FIELD_PRESENT",
      "FIELD_TYPE_INVALID",
      "ENUM_INVALID",
      "ARRAY_TOO_SHORT",
      "ARRAY_TOO_LONG",
      "DUPLICATE_ITEM",
      "PATTERN_INVALID",
      "STRING_TOO_LONG",
      "STRING_TOO_SHORT",
      "OTHER_SCHEMA_INVALID",
    ]);
  });

  it.each<[string, AiEvaluationFixture, () => unknown, object]>([
    ["a non-JSON body", EXPLAIN, () => "{not json", { category: "ROOT_TYPE_INVALID", path: "$", rule: "strict_json", count: 1, boundary: null }],
    ["a non-object root", EXPLAIN, () => ["claim-1"], { category: "ROOT_TYPE_INVALID", path: "$", rule: "object", count: 1, boundary: null }],
    ["a missing required field", EXPLAIN, () => { const o = explain(); delete o.payload.headline; return o; }, { category: "REQUIRED_FIELD_MISSING", path: "payload.headline", rule: "required", count: 1, boundary: null }],
    ["an unknown field", CARE, () => { const o = care(); o.payload.sections[0]["Tan Ah Kow 9.9"] = "S1234567D"; return o; }, { category: "UNKNOWN_FIELD_PRESENT", path: "payload.sections[]", rule: "strict_object", count: 1, boundary: null }],
    ["a wrong field type", EXPLAIN, () => { const o = explain(); o.payload.headline.text = 42; return o; }, { category: "FIELD_TYPE_INVALID", path: "payload.headline.text", rule: "type", count: 1, boundary: null }],
    ["an invalid enum", EXPLAIN, () => ({ ...explain(), locale: "fr-FR" }), { category: "ENUM_INVALID", path: "locale", rule: "enum", count: 1, boundary: null }],
    ["an invalid literal", EXPLAIN, () => ({ ...explain(), taskType: "DRAFT_CARE_PREPARATION_SUMMARY" }), { category: "ENUM_INVALID", path: "taskType", rule: "literal", count: 1, boundary: null }],
    ["a too-short array", EXPLAIN, () => { const o = explain(); o.payload.evidence.factRefs = []; return o; }, { category: "ARRAY_TOO_SHORT", path: "payload.evidence.factRefs", rule: "min_items", count: 1, boundary: 1 }],
    ["a too-long array", CARE, () => { const o = care(); o.payload.sections = Array.from({ length: 9 }, (_, index) => ({ ...o.payload.sections[0], sectionRef: `section-${index + 1}` })); return o; }, { category: "ARRAY_TOO_LONG", path: "payload.sections", rule: "max_items", count: 1, boundary: 8 }],
    ["a duplicate item", CARE, () => { const o = care(); o.payload.sections[0].bullets[0].factRefs = ["fact-1", "fact-1"]; return o; }, { category: "DUPLICATE_ITEM", path: "payload.sections[].bullets[].factRefs", rule: "unique", count: 1, boundary: null }],
    ["a pattern failure", EXPLAIN, () => { const o = explain(); o.payload.headline.claimRefs = ["claim-x"]; return o; }, { category: "PATTERN_INVALID", path: "payload.headline.claimRefs[]", rule: "pattern", count: 1, boundary: null }],
    ["a too-long string", EXPLAIN, () => { const o = explain(); o.payload.headline.text = "a".repeat(161); return o; }, { category: "STRING_TOO_LONG", path: "payload.headline.text", rule: "max_length", count: 1, boundary: 160 }],
    ["an empty string", CARE, () => { const o = care(); o.payload.sections[0].bullets[0].text = ""; return o; }, { category: "STRING_TOO_SHORT", path: "payload.sections[].bullets[].text", rule: "min_length", count: 1, boundary: 1 }],
    ["a schema-version mismatch", EXPLAIN, () => ({ ...explain(), schemaVersion: "ai-output.explain-pattern@11a.9" }), { category: "OTHER_SCHEMA_INVALID", path: "schemaVersion", rule: "exact_schema_version", count: 1, boundary: null }],
  ])("classifies %s while the application result stays SCHEMA_INVALID", (_label, fixture, build, expected) => {
    const output = build();
    expect(validate(fixture, output)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
    const diagnostic = diagnoseSchemaFailure(fixture, output);
    expect(diagnostic).toMatchObject({ version: "packet11-schemadiag.1", fixtureId: fixture.id, taskType: fixture.taskType, locale: fixture.locale });
    expect(diagnostic!.findings).toEqual([expected]);
  });

  it("aggregates repeated findings by category, path and rule with a count", () => {
    const o = care();
    o.payload.sections[0].bullets[0].text = "";
    o.payload.sections[1].bullets[0].text = "";
    expect(findingsOf(CARE, o)).toEqual([{ category: "STRING_TOO_SHORT", path: "payload.sections[].bullets[].text", rule: "min_length", count: 2, boundary: 1 }]);
  });
});

describe("redaction", () => {
  it("never retains hostile, secret-looking or patient-like values, unknown names or raw fragments, and never logs", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    for (const hostile of HOSTILE) {
      const cases: unknown[] = [
        (() => { const o = explain(); o.payload.headline.text = hostile.repeat(200); return o; })(),
        (() => { const o = explain(); o.payload.headline[hostile] = hostile; o[`${hostile}-root`] = 1; return o; })(),
        (() => { const o = explain(); o.payload.headline.claimRefs = [hostile]; return o; })(),
        (() => ({ ...explain(), locale: hostile, taskType: hostile, outcome: hostile }))(),
        `{"payload": "${hostile}"`,
        hostile,
      ];
      for (const output of cases) {
        expect(validate(EXPLAIN, output).kind).toBe("REJECTED");
        const text = JSON.stringify(diagnoseSchemaFailure(EXPLAIN, output));
        for (const fragment of [hostile, ...HOSTILE, "-root", "Tan", "mmol", '{"payload']) if (fragment.trim()) expect(text, fragment).not.toContain(fragment);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("reports an unknown field only by its known parent path", () => {
    const o = explain();
    o["patient_name_Tan"] = "x";
    o.payload.evidence.secret_sk_live = "y";
    const findings = findingsOf(EXPLAIN, o)!;
    expect(findings).toEqual([
      { category: "UNKNOWN_FIELD_PRESENT", path: "$", rule: "strict_object", count: 1, boundary: null },
      { category: "UNKNOWN_FIELD_PRESENT", path: "payload.evidence", rule: "strict_object", count: 1, boundary: null },
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/patient_name|secret_sk/);
  });
});

describe("unchanged acceptance and production behaviour", () => {
  it("produces no diagnostic for accepted output, abstention or a non-schema rejection", () => {
    expect(validate(EXPLAIN, explain()).kind).toBe("ACCEPTED");
    expect(diagnoseSchemaFailure(EXPLAIN, explain())).toBeNull();
    const abstain = { ...explain(), outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT" };
    delete (abstain as Record<string, unknown>).payload;
    expect(diagnoseSchemaFailure(EXPLAIN, abstain)).toBeNull();
    const dangerous = explain();
    dangerous.payload.observation.text = "These readings are dangerous.";
    expect(validate(EXPLAIN, dangerous)).toMatchObject({ reason: "CLINICAL_MEANING_VIOLATION" });
    expect(diagnoseSchemaFailure(EXPLAIN, dangerous)).toBeNull();
  });

  it("production callers still receive only SCHEMA_INVALID and the unchanged deterministic fallback", async () => {
    const broken = care();
    broken.payload.sections[0].bullets[0].factRefs = ["fact-1", "fact-1"];
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" }, invoke: async () => ({ kind: "COMPLETED", candidate: broken, usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: null } }) },
      audit: { append: async () => undefined },
      now: () => "2026-10-06T01:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(CARE.request);
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "SCHEMA_INVALID", presentation: { kind: "STRUCTURED_PREVIEW" } } });
    expect(JSON.stringify(result)).not.toMatch(/schemadiag|DUPLICATE_ITEM|findings/);
  });

  it("no production module can import the evaluation diagnostics", () => {
    const files = (dir: string): string[] =>
      readdirSync(join(process.cwd(), dir)).flatMap((name) => {
        const path = `${dir}/${name}`;
        return statSync(join(process.cwd(), path)).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const offenders = files("src").filter((file) => !file.startsWith("src/ai/evaluation/") && /packet-11-schema-diagnostics|@\/ai\/evaluation\//.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
