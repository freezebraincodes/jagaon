import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { fixturesForPhase, PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";
import { diagnoseReferenceClosure, REFERENCE_DIAGNOSTIC_CATEGORIES, REFERENCE_DIAGNOSTIC_KINDS, REFERENCE_DIAGNOSTIC_PATHS } from "./packet-11-reference-diagnostics";

/** Packet 11B offline, evaluation-only reference-closure diagnostic (owner approval 2026-10-05). */

const EXPLAIN = fixturesForPhase("DIAGNOSTIC")[0]!;
const CARE = fixturesForPhase("SMOKE")[2]!;

function explainOutput(): Record<string, any> {
  const output = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
  output.inputRefsUsed = ["claim-1", "fact-1", "fact-2", "fact-3"];
  output.payload.evidence.factRefs = ["fact-1", "fact-2", "fact-3"];
  return output;
}
const careOutput = () => structuredClone(outputFixture("DRAFT_CARE_PREPARATION_SUMMARY")) as Record<string, any>;
const diagnose = (fixture: AiEvaluationFixture, output: unknown) => diagnoseReferenceClosure(fixture, output);
const validate = (fixture: AiEvaluationFixture, output: unknown) => validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType], output);

afterEach(() => vi.restoreAllMocks());

describe("closed diagnostic vocabulary", () => {
  it("is exactly the approved categories, reference kinds and output paths", () => {
    expect(REFERENCE_DIAGNOSTIC_CATEGORIES).toEqual(["INVENTED_OR_UNSUPPLIED_REFERENCE", "CITED_REFERENCE_NOT_LISTED", "REFERENCE_OUTSIDE_PERMITTED_SCOPE"]);
    expect(REFERENCE_DIAGNOSTIC_KINDS).toEqual(["CLAIM", "FACT", "LIMITATION", "SECTION", "OTHER_LOCAL", "UNRECOGNISED"]);
    expect(REFERENCE_DIAGNOSTIC_PATHS).toEqual(["inputRefsUsed", "headline.claimRefs", "observation.claimRefs", "evidence.factRefs", "sections.sectionRef", "sections.bullets.factRefs"]);
  });
});

describe("reference-closure diagnostic", () => {
  it("returns nothing for an accepted output, and acceptance is unchanged", () => {
    expect(validate(EXPLAIN, explainOutput()).kind).toBe("ACCEPTED");
    expect(diagnose(EXPLAIN, explainOutput())).toBeNull();
  });

  it("classifies an invented provider reference without retaining its raw value", () => {
    const output = explainOutput();
    output.payload.evidence.factRefs = ["fact-1", "fact-417"];
    output.inputRefsUsed.push("fact-417");
    expect(validate(EXPLAIN, output)).toEqual({ kind: "REJECTED", reason: "REFERENCE_MISMATCH", repairable: false });
    const diagnostic = diagnose(EXPLAIN, output);
    expect(diagnostic).toEqual({
      version: "packet11-refdiag.1",
      fixtureId: "p11.explain-pattern.en-sg.ordinary",
      taskType: "EXPLAIN_PATTERN",
      findings: [
        { category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "FACT", path: "evidence.factRefs", count: 1, fixtureReferences: [] },
        { category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "FACT", path: "inputRefsUsed", count: 1, fixtureReferences: [] },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("417");
  });

  it.each([
    ["claim-1", "CLAIM", ["headline.claimRefs", "observation.claimRefs"]],
    ["fact-3", "FACT", ["evidence.factRefs"]],
  ] as const)("safely identifies the known fixture reference %s cited but omitted from inputRefsUsed", (ref, kind, paths) => {
    const output = explainOutput();
    output.inputRefsUsed = output.inputRefsUsed.filter((entry: string) => entry !== ref);
    expect(validate(EXPLAIN, output).kind).toBe("REJECTED");
    expect(diagnose(EXPLAIN, output)!.findings).toEqual(paths.map((path) => ({ category: "CITED_REFERENCE_NOT_LISTED", referenceKind: kind, path, count: 1, fixtureReferences: [ref] })));
  });

  it("classifies a supplied reference used outside its permitted scope", () => {
    const care = careOutput();
    care.payload.sections[0].bullets[0].factRefs = ["fact-2"];
    expect(validate(CARE, care)).toMatchObject({ kind: "REJECTED", reason: "REFERENCE_MISMATCH" });
    expect(diagnose(CARE, care)!.findings).toEqual([{ category: "REFERENCE_OUTSIDE_PERMITTED_SCOPE", referenceKind: "FACT", path: "sections.bullets.factRefs", count: 1, fixtureReferences: ["fact-2"] }]);
  });

  it("classifies an invented section without its value and counts repeated findings", () => {
    const care = careOutput();
    care.payload.sections[1].sectionRef = "section-77";
    care.inputRefsUsed = [...care.inputRefsUsed.filter((entry: string) => entry !== "section-2"), "section-77"];
    expect(diagnose(CARE, care)!.findings).toEqual([
      { category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "SECTION", path: "inputRefsUsed", count: 1, fixtureReferences: [] },
      { category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "SECTION", path: "sections.sectionRef", count: 1, fixtureReferences: [] },
    ]);
  });

  it("records an unsupplied local identifier of another kind value-free", () => {
    const output = explainOutput();
    output.inputRefsUsed.push("record-9", "option-3");
    expect(diagnose(EXPLAIN, output)!.findings).toEqual([{ category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "OTHER_LOCAL", path: "inputRefsUsed", count: 2, fixtureReferences: [] }]);
  });

  it.each([
    ["an NRIC-like string", "S1234567D"],
    ["a secret-looking string", "sk-live-0123456789abcdef0123456789"],
    ["a patient-like sentence", "Tan Ah Kow 6.2 mmol/L at Blk 123"],
    ["an injection", "fact-1\"],\"payload\":{\"x\":1"],
    ["a control character", "fact-1\u0000"],
  ])("never lets %s into diagnostics or logs", (_label, hostile) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    for (const place of ["inputRefsUsed", "evidence"] as const) {
      const output = explainOutput();
      if (place === "inputRefsUsed") output.inputRefsUsed.push(hostile);
      else output.payload.evidence.factRefs = [hostile];
      const diagnostic = diagnose(EXPLAIN, output);
      const text = JSON.stringify(diagnostic);
      for (const fragment of [hostile, "S1234567D", "sk-live", "Tan Ah Kow", "6.2", "Blk", "payload"]) expect(text).not.toContain(fragment);
      expect(diagnose(EXPLAIN, JSON.stringify(output))).toEqual(diagnostic);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("records known identifiers only for the shipped synthetic fixtures", () => {
    const foreign: AiEvaluationFixture = { ...EXPLAIN, id: "p11.foreign" };
    const output = explainOutput();
    output.inputRefsUsed = output.inputRefsUsed.filter((entry: string) => entry !== "fact-3");
    expect(PACKET_11_FIXTURES).not.toContain(foreign);
    expect(diagnose(foreign, output)!.findings).toEqual([{ category: "CITED_REFERENCE_NOT_LISTED", referenceKind: "FACT", path: "evidence.factRefs", count: 1, fixtureReferences: [] }]);
    expect(diagnose(foreign, output)!.fixtureId).toBeNull();
  });

  it("returns nothing for output that is not a strict-schema SUCCESS envelope of a remote task", () => {
    expect(diagnose(EXPLAIN, "{not json")).toBeNull();
    expect(diagnose(EXPLAIN, { ...explainOutput(), outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT", payload: undefined })).toBeNull();
    expect(diagnose(EXPLAIN, { ...explainOutput(), extra: "Tan Ah Kow" })).toBeNull();
  });
});

describe("production isolation", () => {
  it("production callers still receive only REFERENCE_MISMATCH and the deterministic fallback", async () => {
    const output = explainOutput();
    output.inputRefsUsed = output.inputRefsUsed.filter((entry: string) => entry !== "claim-1");
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" }, invoke: async () => ({ kind: "COMPLETED", candidate: output, usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: null } }) },
      audit: { append: async () => undefined },
      now: () => "2026-10-05T03:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(EXPLAIN.request);
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "REFERENCE_MISMATCH", presentation: { kind: "TEMPLATE_PATTERN_CARD" } } });
    expect(JSON.stringify(result)).not.toMatch(/CITED_REFERENCE_NOT_LISTED|refdiag|findings|fixtureReferences/);
  });

  it("no production module can import the evaluation boundary", () => {
    const files = (dir: string): string[] =>
      readdirSync(join(process.cwd(), dir)).flatMap((name) => {
        const path = `${dir}/${name}`;
        return statSync(join(process.cwd(), path)).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
      });
    const offenders = files("src").filter((file) => !file.startsWith("src/ai/evaluation/") && /from\s+["'](@\/ai\/evaluation|[./]+\/evaluation)\//.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("Option B: limitation references never cross the provider boundary", () => {
  it("reports a limitation reference in inputRefsUsed as invented, matching the validator's REFERENCE_MISMATCH", () => {
    const fixture = fixturesForPhase("SMOKE").find((entry) => entry.taskType === "EXPLAIN_PATTERN" && entry.locale === "en-SG")!;
    const candidate = structuredClone(outputFixture("EXPLAIN_PATTERN")) as { inputRefsUsed: string[] };
    candidate.inputRefsUsed = [...candidate.inputRefsUsed, "limitation-1"];
    const verdict = validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, candidate);
    expect(verdict).toMatchObject({ kind: "REJECTED", reason: "REFERENCE_MISMATCH" });
    expect(diagnoseReferenceClosure(fixture, candidate)?.findings).toEqual([expect.objectContaining({ category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "LIMITATION", path: "inputRefsUsed" })]);
  });
});
