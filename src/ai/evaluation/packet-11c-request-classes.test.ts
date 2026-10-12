// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import { AI_REQUEST_CLASS_CONTRACT, AI_REQUEST_CLASS_DEFINITIONS, AI_REQUEST_CLASS_SCHEME } from "@/application/ai/request-class-definitions";
import { AI_REQUEST_CLASS_QUALIFICATION_RECORDS, requestClassId, requestClassIdentity, shellRequestDigest } from "@/application/ai/request-class-qualification";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "@/application/care-preparation/care-preparation-test-support";
import { renderDeterministicCareSummary } from "@/application/care-preparation/deterministic-care-summary-renderer";
import { AI_LOCALES, type AiTaskRequest, type ShellTask } from "@/domain/ai";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";
import { capture } from "./packet-11-presentation-guard.test";
import {
  generateRequestClassDefinitions,
  projectedFixtureRequest,
  renderQualificationRecordsBlock,
  renderRequestClassDefinitionsModule,
  requestClassContractDigest,
  requestClassContractInputsFromCode,
  splitQualificationModule,
} from "./packet-11c-request-class-generator";
import { SOURCE_BACKED_SCENARIOS, sourceBackedFixture } from "./packet-11-source-backed-fixtures";

/**
 * Packet 11C Addendum C, Task C1: the immutable request-class definitions are generated from the frozen request builders over the 70 FULL
 * fixtures and bound to the frozen model-facing contract. Offline: the real DeepSeek shell adapter with a recording fetcher that throws.
 * "Samples" are FULL fixtures sharing one identical model-facing body; nothing here claims the model saw any fixture's patient text.
 *
 * CL3 contract re-freeze (Task RF, C1-review carry): the contract inputs also carry each class's captured model-facing body sha256 and the
 * endpoint sha256 (cross-checked below against the presentation guard's own capture), the shipped qualification records literal is
 * regenerated and must be byte-identical, and the source-backed and care class assertions name the exact class.
 *
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12): the regenerated literal now carries the owner's sign-off records
 * pinned below (`OWNER_SIGN_OFFS_11C_EN`): exactly the six en-SG classes QUALIFIED with the protocol record as evidence (a waiver of the
 * manual review, not a completed human-review PASS); the six zh-SG classes stay PENDING with no evidence and no sign-off.
 */

const DEFINITIONS_FILE = join(process.cwd(), "src/application/ai/request-class-definitions.ts");
const QUALIFICATION_FILE = join(process.cwd(), "src/application/ai/request-class-qualification.ts");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The owner's sign-off (decision Q, 2026-10-12 02:13 SGT): the six en-SG classes of contract 4fca780a…39b1, in definition order. */
const EN_DEMO_CONTRACT = "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1";
const OWNER_SIGN_OFF = { evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" } as const;
const OWNER_SIGN_OFFS_11C_EN = [
  ["a00d8ad562619f605ca03fe406c18abe095410db4d6f53cca02f68601104910d", "EXPLAIN_PATTERN"],
  ["0c43de4a6cfb9eb6ec40c2ae13404c8f7664b127e864724452dbf0dc3f40a1f7", "EXPLAIN_PATTERN"],
  ["38ad0280e6382f4e3b314613b464bef0438ea6f6cc19cae2f41a10e0550e320d", "EXPLAIN_PATTERN"],
  ["5d0c75cef363c190e726f5cb055f4f9b6b265b76b7f8779b612467203ac6adca", "DRAFT_CARE_PREPARATION_SUMMARY"],
  ["37f7e95a9ff5436dbaab17b1bfefa57d132aaf7f407157c9d3cd2e3a39c9154f", "DRAFT_CARE_PREPARATION_SUMMARY"],
  ["8c3203f88db4567aa82a51d86967b845960f8f7f226591416c476c2ea670ec6b", "DRAFT_CARE_PREPARATION_SUMMARY"],
].map(([classId, taskType]) => ({ taskType, record: { classId: classId!, contractDigest: EN_DEMO_CONTRACT, status: "QUALIFIED" as const, ...OWNER_SIGN_OFF } }));

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
  it("the committed module is byte-identical to the module regenerated from the frozen sources", async () => {
    expect(readFileSync(DEFINITIONS_FILE, "utf8")).toBe(await renderRequestClassDefinitionsModule());
  }, 30_000);

  it("the shipped qualification records literal is byte-identical to the regenerated one: one per definition, the six en-SG classes QUALIFIED by the owner's sign-off, the six zh-SG classes PENDING with no evidence", () => {
    // Packet 11C English activation (owner decisions Q and A): the owner's sign-offs are each an en-SG definition of the stated task.
    expect(AI_REQUEST_CLASS_CONTRACT.digest).toBe(EN_DEMO_CONTRACT);
    for (const { taskType, record } of OWNER_SIGN_OFFS_11C_EN) {
      expect(AI_REQUEST_CLASS_DEFINITIONS.find((definition) => definition.classId === record.classId), record.classId).toMatchObject({ taskType, locale: "en-SG", contractDigest: EN_DEMO_CONTRACT });
    }
    expect(AI_REQUEST_CLASS_DEFINITIONS.filter((definition) => definition.locale === "en-SG").map((definition) => definition.classId)).toEqual(OWNER_SIGN_OFFS_11C_EN.map(({ record }) => record.classId));
    const { records } = splitQualificationModule(readFileSync(QUALIFICATION_FILE, "utf8"));
    expect(records).toBe(renderQualificationRecordsBlock(AI_REQUEST_CLASS_DEFINITIONS, OWNER_SIGN_OFFS_11C_EN.map(({ record }) => record)));
    expect(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => [record.classId, record.contractDigest, record.status, record.evidenceRef, record.signedOffBy, record.signedOffAt])).toEqual(
      AI_REQUEST_CLASS_DEFINITIONS.map((definition) =>
        definition.locale === "en-SG"
          ? [definition.classId, AI_REQUEST_CLASS_CONTRACT.digest, "QUALIFIED", OWNER_SIGN_OFF.evidenceRef, OWNER_SIGN_OFF.signedOffBy, OWNER_SIGN_OFF.signedOffAt]
          : [definition.classId, AI_REQUEST_CLASS_CONTRACT.digest, "PENDING", null, null, null],
      ),
    );
    // Without the owner's sign-offs the generator renders every record PENDING; it never decides a status.
    expect(renderQualificationRecordsBlock(AI_REQUEST_CLASS_DEFINITIONS)).not.toMatch(/QUALIFIED/);
    expect(renderQualificationRecordsBlock(AI_REQUEST_CLASS_DEFINITIONS).match(/status: "PENDING"/g)).toHaveLength(AI_REQUEST_CLASS_DEFINITIONS.length);
    // A sign-off for an unknown class, another contract, twice, or schema-invalid is refused.
    const first = OWNER_SIGN_OFFS_11C_EN[0]!.record;
    for (const invalid of [[{ ...first, classId: "0".repeat(64) }], [{ ...first, contractDigest: "0".repeat(64) }], [first, first], [{ ...first, evidenceRef: "" }]]) {
      expect(() => renderQualificationRecordsBlock(AI_REQUEST_CLASS_DEFINITIONS, invalid as never), JSON.stringify(invalid)).toThrow();
    }
  });

  it("the contract binds each class's exact model-facing body and the endpoint (cross-checked with the presentation guard's capture)", async () => {
    const { modelFacingBodySha256, endpointSha256 } = AI_REQUEST_CLASS_CONTRACT.inputs;
    expect(Object.keys(modelFacingBodySha256)).toEqual(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.shellRequestDigest));
    expect(endpointSha256).toBe(sha256(DEEPSEEK_RESPONSES_URL));
    const fixtures = hybridFixturesForPhase("FULL");
    for (const definition of AI_REQUEST_CLASS_DEFINITIONS) {
      for (const id of definition.sampleFixtureIds) {
        const { body } = await capture(fixtures.find((fixture) => fixture.id === id)!);
        expect(sha256(body!), `${definition.classId} ${id}`).toBe(modelFacingBodySha256[definition.shellRequestDigest]);
      }
    }
  }, 60_000);

  it("the contract is the frozen contract read from the code, and its digest is sha256 of the canonical { scheme, inputs }", async () => {
    expect(AI_REQUEST_CLASS_CONTRACT.scheme).toBe("ai-request-class.11c.1");
    expect(AI_REQUEST_CLASS_SCHEME).toBe("ai-request-class.11c.1");
    expect(AI_REQUEST_CLASS_CONTRACT.inputs).toEqual(await requestClassContractInputsFromCode());
    expect(AI_REQUEST_CLASS_CONTRACT.digest).toBe(requestClassContractDigest(AI_REQUEST_CLASS_CONTRACT.inputs));
    expect(Object.isFrozen(AI_REQUEST_CLASS_CONTRACT) && Object.isFrozen(AI_REQUEST_CLASS_CONTRACT.inputs) && Object.isFrozen(AI_REQUEST_CLASS_DEFINITIONS)).toBe(true);
    expect(AI_REQUEST_CLASS_DEFINITIONS.every((definition) => Object.isFrozen(definition) && Object.isFrozen(definition.sampleFixtureIds))).toBe(true);
    expect(Object.isFrozen(AI_REQUEST_CLASS_CONTRACT.inputs.modelFacingBodySha256)).toBe(true);
  }, 30_000);

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
        // CL3 re-freeze (C1-review carry): exactly the evaluated 9-sample class whose samples include the ordinary fixture.
        expect(definition!.sampleFixtureIds, `${locale} ${scenario}`).toHaveLength(9);
        expect(definition!.sampleFixtureIds).toContain(`p11.explain-pattern.${locale.toLowerCase()}.ordinary`);
        ids.add(definition!.classId);
      }
      expect(ids.size, locale).toBe(1);
      // CL3 re-freeze: the care class of each synthetic draft shape, in the draft's own locale (ORDINARY: the 15-sample class with the
      // ordinary fixture; HIDDEN_LIMITATION: the 1-sample hidden-limitation class).
      const careClass = { ORDINARY: { samples: 15, fixture: "ordinary" }, HIDDEN_LIMITATION: { samples: 1, fixture: "hidden-limitation" } } as const;
      for (const shape of ["ORDINARY", "HIDDEN_LIMITATION"] as SyntheticCareDraftShape[]) {
        const current = (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
        const built = buildCareSummaryAiRequest({ current, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: NOW });
        if (built.kind !== "READY") throw new Error(built.reason);
        const definition = classOf(projected(built.request, "DRAFT_CARE_PREPARATION_SUMMARY"));
        expect(definition, `${locale} ${shape}`).toBeDefined();
        expect(definition!.taskType).toBe("DRAFT_CARE_PREPARATION_SUMMARY");
        expect(definition!.locale, `${locale} ${shape}`).toBe(locale);
        expect(definition!.sampleFixtureIds, `${locale} ${shape}`).toHaveLength(careClass[shape as keyof typeof careClass].samples);
        expect(definition!.sampleFixtureIds).toContain(`p11.draft-care-preparation-summary.${locale.toLowerCase()}.${careClass[shape as keyof typeof careClass].fixture}`);
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
