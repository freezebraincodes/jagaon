// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_REQUEST_CLASS_CONTRACT, AI_REQUEST_CLASS_DEFINITIONS, AI_REQUEST_CLASS_SCHEME } from "@/application/ai/request-class-definitions";
import { requestClassId, requestClassIdentity, shellRequestDigest } from "@/application/ai/request-class-qualification";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "@/application/care-preparation/care-preparation-test-support";
import { renderDeterministicCareSummary } from "@/application/care-preparation/deterministic-care-summary-renderer";
import { AI_LOCALES, type AiTaskRequest, type ShellTask } from "@/domain/ai";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";
import { capture } from "./packet-11-presentation-guard.test";
import { generateRequestClassDefinitions, projectedFixtureRequest, renderRequestClassDefinitionsModule, requestClassContractDigest, requestClassContractInputsFromCode } from "./packet-11c-request-class-generator";
import { SOURCE_BACKED_SCENARIOS, sourceBackedFixture } from "./packet-11-source-backed-fixtures";

/**
 * Packet 11C Addendum C, Task C1: the immutable request-class definitions are generated from the frozen request builders over the 70 FULL
 * fixtures and bound to the frozen model-facing contract. Offline: the real DeepSeek shell adapter with a recording fetcher that throws.
 * "Samples" are FULL fixtures sharing one identical model-facing body; nothing here claims the model saw any fixture's patient text.
 */

const DEFINITIONS_FILE = join(process.cwd(), "src/application/ai/request-class-definitions.ts");

beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_REQUEST_CLASSES");
  });
});
afterAll(() => vi.unstubAllGlobals());

const projected = (request: AiTaskRequest, task: ShellTask) => {
  const planned = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[task]);
  if (planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true) throw new Error("NOT_PROJECTABLE");
  return projectShellTaskRequest(planned.plan);
};

describe("Packet 11C C1 request-class definitions (generated, immutable, contract-bound)", () => {
  it("the committed module is byte-identical to the module regenerated from the frozen sources", () => {
    expect(readFileSync(DEFINITIONS_FILE, "utf8")).toBe(renderRequestClassDefinitionsModule());
  });

  it("the contract is the frozen contract read from the code, and its digest is sha256 of the canonical { scheme, inputs }", () => {
    expect(AI_REQUEST_CLASS_CONTRACT.scheme).toBe("ai-request-class.11c.1");
    expect(AI_REQUEST_CLASS_SCHEME).toBe("ai-request-class.11c.1");
    expect(AI_REQUEST_CLASS_CONTRACT.inputs).toEqual(requestClassContractInputsFromCode());
    expect(AI_REQUEST_CLASS_CONTRACT.digest).toBe(requestClassContractDigest(AI_REQUEST_CLASS_CONTRACT.inputs));
    expect(Object.isFrozen(AI_REQUEST_CLASS_CONTRACT) && Object.isFrozen(AI_REQUEST_CLASS_CONTRACT.inputs) && Object.isFrozen(AI_REQUEST_CLASS_DEFINITIONS)).toBe(true);
    expect(AI_REQUEST_CLASS_DEFINITIONS.every((definition) => Object.isFrozen(definition) && Object.isFrozen(definition.sampleFixtureIds))).toBe(true);
  });

  it("every definition is bound to the contract: classId = sha256(contractDigest || shellRequestDigest); classes are distinct", () => {
    for (const definition of AI_REQUEST_CLASS_DEFINITIONS) {
      expect(definition.contractDigest).toBe(AI_REQUEST_CLASS_CONTRACT.digest);
      expect(definition.classId).toBe(requestClassId(definition.contractDigest, definition.shellRequestDigest));
    }
    expect(new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId)).size).toBe(AI_REQUEST_CLASS_DEFINITIONS.length);
    expect(new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.shellRequestDigest)).size).toBe(AI_REQUEST_CLASS_DEFINITIONS.length);
  });

  it("any contract change changes every classId (no unversioned structural hash)", () => {
    const changed = requestClassContractDigest({ ...AI_REQUEST_CLASS_CONTRACT.inputs, temperature: 0.3 });
    const other = generateRequestClassDefinitions(changed);
    expect(other.map((definition) => definition.shellRequestDigest)).toEqual(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.shellRequestDigest));
    const current = new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId));
    expect(other.filter((definition) => current.has(definition.classId))).toEqual([]);
    for (const key of Object.keys(AI_REQUEST_CLASS_CONTRACT.inputs) as Array<keyof typeof AI_REQUEST_CLASS_CONTRACT.inputs>) {
      expect(requestClassContractDigest({ ...AI_REQUEST_CLASS_CONTRACT.inputs, [key]: "changed" } as never), key).not.toBe(AI_REQUEST_CLASS_CONTRACT.digest);
    }
  });

  it("the classes partition the remote-eligible FULL fixtures; each class's samples share one identical model-facing body and no two classes share a body", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    expect(fixtures).toHaveLength(70);
    const sampled = AI_REQUEST_CLASS_DEFINITIONS.flatMap((definition) => definition.sampleFixtureIds);
    expect(new Set(sampled).size).toBe(sampled.length);
    const eligible = fixtures.filter((fixture) => projectedFixtureRequest(fixture) !== null).map((fixture) => fixture.id);
    expect([...sampled].sort()).toEqual([...eligible].sort());
    const bodyOf = new Map<string, string>();
    for (const fixture of fixtures) {
      const { body } = await capture(fixture);
      if (body !== null) bodyOf.set(fixture.id, body);
    }
    expect([...bodyOf.keys()].sort()).toEqual([...eligible].sort());
    const classBodies = AI_REQUEST_CLASS_DEFINITIONS.map((definition) => {
      const bodies = new Set(definition.sampleFixtureIds.map((id) => bodyOf.get(id)));
      expect(bodies.size, definition.classId).toBe(1);
      for (const id of definition.sampleFixtureIds) {
        const fixture = fixtures.find((entry) => entry.id === id)!;
        expect(fixture.taskType).toBe(definition.taskType);
        expect(fixture.request.locale).toBe(definition.locale);
        expect(shellRequestDigest(projectedFixtureRequest(fixture)!)).toBe(definition.shellRequestDigest);
      }
      return [...bodies][0];
    });
    expect(new Set(classBodies).size).toBe(classBodies.length);
  }, 60_000);

  it("covers both source-backed EXPLAIN classes (one per locale, all six scenarios) and the evaluated care classes through the fixtures sharing their body", async () => {
    const classOf = (request: Parameters<typeof requestClassIdentity>[0]) => AI_REQUEST_CLASS_DEFINITIONS.find((definition) => definition.classId === requestClassIdentity(request).classId);
    for (const locale of AI_LOCALES) {
      const ids = new Set<string>();
      for (const scenario of SOURCE_BACKED_SCENARIOS) {
        const definition = classOf(projected((await sourceBackedFixture(locale, scenario)).request, "EXPLAIN_PATTERN"));
        expect(definition, `${locale} ${scenario}`).toBeDefined();
        expect(definition!.taskType).toBe("EXPLAIN_PATTERN");
        expect(definition!.locale).toBe(locale);
        ids.add(definition!.classId);
      }
      expect(ids.size, locale).toBe(1);
      for (const shape of ["ORDINARY", "HIDDEN_LIMITATION"] as SyntheticCareDraftShape[]) {
        const current = (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
        const built = buildCareSummaryAiRequest({ current, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: NOW });
        if (built.kind !== "READY") throw new Error(built.reason);
        const definition = classOf(projected(built.request, "DRAFT_CARE_PREPARATION_SUMMARY"));
        expect(definition, `${locale} ${shape}`).toBeDefined();
        expect(definition!.taskType).toBe("DRAFT_CARE_PREPARATION_SUMMARY");
      }
    }
    // Packet 11C Addendum C, C3 fix round 1: an offline test-execution allowance only (12 fake-IndexedDB source-backed harnesses and 4
    // care renders; about 2 s alone, it reached the 5 s default under parallel full-suite load). Not a production timeout; no assertion
    // changed.
  }, 30_000);

  it("the definitions module is plain data: it imports only domain types (no evaluation, prompt, provider or credential code)", () => {
    const source = readFileSync(DEFINITIONS_FILE, "utf8");
    expect([...source.matchAll(/^import .*$/gm)].map((match) => match[0])).toEqual([`import type { AiLocale, ShellTask } from "@/domain/ai";`]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.env|fetch\s*\(|evaluation|@\/ai\/|require\(|import\(/);
  });
});
