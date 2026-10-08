// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import type { AiShellProviderPort, ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { verifyComposition } from "@/application/ai/language/assembler";
import { composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { defaultShells } from "@/application/ai/language/default-shells";
import { composeObservationShell, selectObservationVariant } from "@/application/ai/language/observation-composer";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { validateShellCandidate } from "@/application/ai/language/shell-validator";
import { planSlots } from "@/application/ai/language/slot-planner";
import { shellOutputJsonSchema } from "@/ai/kie/kie-shell-contracts";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { SHELL_INPUT_VERSIONS, SHELL_OUTPUT_VERSIONS, SLOT_PLAN_VERSION, remoteFields, remoteTokenInventory, type AiLocale, type ShellFieldPath, type ShellTaskRequest, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { evaluateHybridModelSnapshot } from "./packet-11-hybrid-evaluation";
import { buildHybridHumanReview } from "./packet-11-hybrid-human-review";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { captureShellRequestBody } from "./packet-11-hybrid-live-diagnostic";
import { plannedFixture, shellCandidate } from "./packet-11-hybrid-test-support";
import { normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";

/**
 * Observation ownership (owner instruction 2026-10-07, offline only, brief obsown-brief.md): the application composes every
 * EXPLAIN_PATTERN observation; the remote model writes only the EXPLAIN headline and evidence. Care is unchanged.
 */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const EXPLAIN = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.taskType === "EXPLAIN_PATTERN");
const CARE = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.taskType === "DRAFT_CARE_PREPARATION_SUMMARY");
const planOf = (id: string) => plannedFixture(id);
const observationSlotIds = (plan: SlotPlan) => plan.fields.find((field) => field.path === "observation")!.requiredSlots;
const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, out);
  else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) { out.push(key); strings(entry, out); }
  return out;
};
const numbers = (value: unknown, out: number[] = []): number[] => {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) numbers(entry, out);
  else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) numbers(entry, out);
  return out;
};
const remoteDefaults = (plan: SlotPlan): ShellTexts => new Map([...defaultShells(plan)].filter(([path]) => path !== "observation")) as ShellTexts;
const ENABLED = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } } as typeof AI_ACTIVATION_MANIFEST;
/** A fake model that answers each value-blind request with the approved default wording of exactly the requested fields. */
const echoing = (): AiShellProviderPort => ({
  providerModel: { providerKey: "fake", modelSnapshot: "fake-model" },
  async invoke(input: ShellTaskRequest): Promise<ProviderInvocationResult> {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => JSON.stringify(projectShellTaskRequest(planOf(entry.id).plan)) === JSON.stringify(input))!;
    const { plan } = planOf(fixture.id);
    return { kind: "COMPLETED", candidate: shellCandidate(plan, remoteDefaults(plan)), usage: { inputTokens: 600, outputTokens: 60, costMicroUsd: 300 }, responseModel: "fake-model", retention: "CONFIRMED_NOT_STORED" };
  },
});

// Pre-change baselines, captured before this change (prompt 11b.17, @11b.17, ai-slot-plan.11b.7) with the same fixtures:
// the deterministic compositions of all 70 fixtures, and the 36 remote-eligible care request bodies built by the shared builder.
const DETERMINISTIC_70_DIGEST = "82fa4af83f2a0a82ffaad5441dfa6eacf1c5c526b2a0f933d7b161a17bd26391";
const CARE_BODIES_11B17_DIGEST = "e5407eae901ebd201dbebeda3ad21980d09fee6aad333140e9eab0999c21f296";

describe("observation ownership: the plan keeps every field and marks its owner", () => {
  it("ai-slot-plan.11b.8 (11b.9 since Packet 11C phase 2: eligibility accounting only): EXPLAIN headline and evidence are REMOTE, the observation LOCAL; care fields are all REMOTE; slot ids and order unchanged", () => {
    expect(SLOT_PLAN_VERSION).toBe("ai-slot-plan.11b.9");
    for (const fixture of EXPLAIN) {
      const { plan } = planOf(fixture.id);
      expect(plan.fields.map((field) => [field.path, field.owner]), fixture.id).toEqual([["headline", "REMOTE"], ["observation", "LOCAL"], ["evidence", "REMOTE"]]);
      expect(plan.slots.map((slot) => slot.slotId)).toEqual(plan.slots.map((_, index) => `S${index + 1}`));
      expect(plan.fields.flatMap((field) => field.requiredSlots)).toEqual(plan.slots.map((slot) => slot.slotId));
      expect(remoteTokenInventory(plan)).toEqual([...plan.fields[0]!.requiredSlots, ...plan.fields[2]!.requiredSlots]);
    }
    for (const fixture of CARE) {
      const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
      if (planned.kind === "PLANNED") expect(new Set(planned.plan.fields.map((field) => field.owner))).toEqual(new Set(["REMOTE"]));
    }
  });
});

describe("observation ownership: the remote request", () => {
  it("projection: EXPLAIN carries only the headline and evidence fields, their slots, budgets and the remote inventory", () => {
    for (const fixture of EXPLAIN) {
      const { plan } = planOf(fixture.id);
      const request = projectShellTaskRequest(plan);
      const local = observationSlotIds(plan);
      expect(request.shellInputVersion).toBe("ai-shell-input.explain-pattern@11b.8");
      expect(request.shellSchemaVersion).toBe("ai-shell.explain-pattern@11b.8");
      expect(request.fields.map((field) => field.path)).toEqual(["headline", "evidence"]);
      expect(request.fields.map((field) => [field.maxCodePoints, field.maxSentences])).toEqual(remoteFields(plan).map((field) => [field.maxCodePoints, field.maxSentences]));
      expect(request.tokenInventory).toEqual(remoteTokenInventory(plan));
      expect(request.slots.map((slot) => slot.slotId)).toEqual(remoteTokenInventory(plan));
      expect(request.slots.some((slot) => local.includes(slot.slotId))).toBe(false);
    }
  });
  it("the actual request BYTES (shared builder, capture-only fetcher) carry no observation key, path, gloss, budget or slot id", async () => {
    for (const fixture of EXPLAIN) {
      const { plan } = planOf(fixture.id);
      const body = await captureShellRequestBody(fixture);
      expect(body, fixture.id).not.toBeNull();
      expect(body!.toLowerCase(), fixture.id).not.toContain("observation");
      const parsed = JSON.parse(body!) as { input: Array<{ content: Array<{ text: string }> }>; text: { format: { schema: unknown } } };
      const input = JSON.parse(parsed.input[0]!.content[0]!.text) as unknown;
      const inputStrings = strings(input);
      for (const slotId of observationSlotIds(plan)) {
        expect(inputStrings, `${fixture.id} ${slotId}`).not.toContain(slotId);
        // The shared CONTRACT paragraph of the fixed prompt illustrates the token format ("{{S1}}, {{S2}} and so on"); the request
        // input and the output schema never name an observation slot.
        expect(parsed.input[0]!.content[0]!.text).not.toContain(slotId);
        expect(JSON.stringify(parsed.text.format.schema)).not.toContain(slotId);
      }
      const locale = fixture.locale as AiLocale;
      for (const slot of plan.slots.filter((entry) => entry.homeField === "observation")) expect(body).not.toContain(AI_LANGUAGE_COPY.glosses[slot.glossKey][locale]);
      const budget = plan.fields.find((field) => field.path === "observation")!.maxCodePoints;
      expect(numbers((input as { fields: unknown }).fields)).not.toContain(budget);
      expect(strings(parsed.text.format.schema)).not.toContain("observation");
    }
  });
  it("care request bytes are unchanged apart from the moved version pins (digest pinned against the pre-change bodies)", async () => {
    const bodies: string[] = [];
    for (const fixture of CARE) {
      const body = await captureShellRequestBody(fixture);
      if (body !== null) bodies.push(body);
    }
    expect(bodies).toHaveLength(36);
    // Packet 11C phase 2: the slot plan moved again (11b.9, eligibility accounting only). The documented structural version-only
    // normalisation first maps 11b.9 back to 11b.8 (exactly the 2 version fields of every body), then the existing historical mapping
    // takes 11b.8 back to the 11b.17-era 11b.7.
    const versionNormalised = bodies.map((body) => normaliseSlotPlanVersion(body));
    expect(versionNormalised.map((entry) => entry.occurrences)).toEqual(bodies.map(() => SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY));
    const normalised = versionNormalised.map(({ body }) => body.replaceAll("ai-slot-plan.11b.8", "ai-slot-plan.11b.7").replaceAll("@11b.18", "@11b.17"));
    expect(sha256(normalised.join("\n"))).toBe(CARE_BODIES_11B17_DIGEST);
    for (const body of bodies) {
      expect(body).toContain("ai-slot-plan.11b.9");
      expect(body).toContain("ai.draft-care-preparation-summary@11b.18");
      expect(body).toContain("ai-shell-input.draft-care-preparation-summary@11b.7");
    }
  });
});

describe("observation ownership: the shell output and gates", () => {
  it("a model-provided observation is rejected at S2 (SCHEMA_INVALID) and the provider schema has no observation property", () => {
    const { plan } = planOf("p11.explain-pattern.en-sg.ordinary");
    const base = shellCandidate(plan, remoteDefaults(plan)) as { shells: Record<string, string> };
    expect(Object.keys(base.shells)).toEqual(["headline", "evidence"]);
    const bundle = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
    expect(validateShellCandidate(plan, bundle, base).kind).toBe("VALID");
    expect(validateShellCandidate(plan, bundle, { ...base, shells: { ...base.shells, observation: "Your records show {{S2}}." } })).toMatchObject({ kind: "REJECTED", gate: "S2", reason: "SCHEMA_INVALID" });
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const schema = shellOutputJsonSchema("EXPLAIN_PATTERN", locale) as any;
      expect(schema.properties.shells.anyOf[0]).toMatchObject({ additionalProperties: false, required: ["headline", "evidence"] });
      expect(Object.keys(schema.properties.shells.anyOf[0].properties)).toEqual(["headline", "evidence"]);
    }
  });
  it("the echoed inventory must be exactly the remote inventory (the full plan inventory is S3 INVENTORY_MISMATCH)", () => {
    const { plan } = planOf("p11.explain-pattern.zh-sg.forbidden-cause");
    const base = shellCandidate(plan, remoteDefaults(plan));
    expect((base as { tokenInventory: string[] }).tokenInventory).toEqual(["S1", "S5"]);
    const full = { ...base, tokenInventory: plan.fields.flatMap((field) => field.requiredSlots) };
    expect(validateShellCandidate(plan, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, full)).toMatchObject({ kind: "REJECTED", gate: "S3", integrity: "INVENTORY_MISMATCH" });
  });
});

describe("observation ownership: composition", () => {
  it("deterministic fallback: all 70 compositions are byte-identical to the pre-change compositions (always variant 0)", () => {
    const lines: string[] = [];
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"];
      const planned = planSlots(fixture.request, bundle);
      if (planned.kind !== "PLANNED") { lines.push(`${fixture.id}:UNPLANNABLE:${planned.reason}`); continue; }
      // Presentation correction P1 (ai-language-copy.11b.8, 2026-10-08) changed the default item wording and quotes items on purpose:
      // with the 11b.7 default item wording restored and no item quotes, all 70 compositions still equal the pre-change digest.
      const legacy = structuredClone(AI_LANGUAGE_COPY) as any;
      legacy.explainDefaults["en-SG"].items = "Recorded items: {items}.";
      legacy.explainDefaults["zh-SG"].items = "记录的项目：{items}。";
      legacy.quotes = { "en-SG": ["", ""], "zh-SG": ["", ""] };
      const composition = composeDeterministic(fixture.request, planned.plan, planned.atoms, bundle, legacy);
      lines.push(JSON.stringify({ id: fixture.id, output: composition.output, intros: composition.sectionIntros, fields: [...composition.fields.entries()] }));
      if (fixture.taskType === "EXPLAIN_PATTERN") expect(defaultShells(planned.plan).get("observation")).toBe(composeObservationShell(planned.plan, 0));
    }
    expect(lines).toHaveLength(70);
    expect(sha256(lines.join("\n"))).toBe(DETERMINISTIC_70_DIGEST);
  });

  it("through the service (fake model, REMOTE_AI): every EXPLAIN fixture is an AI composition whose observation is the selected deterministic variant, accepted by the real r7", async () => {
    const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", manifest: ENABLED, provider: echoing(), audit: { append: async () => undefined }, now: () => "2026-10-07T10:00:00.000Z", monotonicMs: () => 0 });
    for (const fixture of EXPLAIN) {
      const { request, plan, atoms } = planOf(fixture.id);
      const result = await service.execute(request);
      expect(result, fixture.id).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
      if (result.kind !== "COMPOSED") continue;
      const variant = selectObservationVariant(request.requestId, request.locale);
      const expected = composeDeterministic(request, plan, atoms, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
      const observation = result.composition.fields.get("observation" as ShellFieldPath)!;
      expect(observation.spans.map((span) => span.slotId)).toEqual([...observationSlotIds(plan)]);
      expect(observation.text).not.toBe(expected.fields.get("observation" as ShellFieldPath)!.text);
      expect(variant).toBeGreaterThanOrEqual(1);
      expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, result.composition).kind).toBe("ACCEPTED");
    }
  });

  // Presentation correction P1 (ai-language-copy.11b.8, 2026-10-08): supplied items are quoted as the person's own words.
  it("the problematic multi-fact fixtures (en and zh) now read as separate recorded statements with no link", async () => {
    const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", manifest: ENABLED, provider: echoing(), audit: { append: async () => undefined }, now: () => "2026-10-07T10:00:00.000Z", monotonicMs: () => 0 });
    const expected: Record<string, string> = {
      "p11.explain-pattern.en-sg.forbidden-adherence": "The recorded values are 10.4 mmol/L and 11.1 mmol/L. Other recorded item, in your own words: “forgot breakfast tablet”.",
      "p11.explain-pattern.en-sg.forbidden-cause": "Your records list 6.0 mmol/L and 9.4 mmol/L. Also recorded, in your own words: “nasi lemak” and “teh tarik”.",
      "p11.explain-pattern.en-sg.abstention": "Your records include entries dated 28 Sept 2026 and 1 Oct 2026.",
      "p11.explain-pattern.en-sg.missing-data": "The recorded value is 6.8 mmol/L.",
      "p11.explain-pattern.zh-sg.forbidden-adherence": "您的记录中列出了 10.4 mmol/L 和 11.1 mmol/L。另外记录的项目（您的原文）：“忘了早餐的药片”。",
      "p11.explain-pattern.zh-sg.forbidden-cause": "记录的数值为 6.0 mmol/L 和 9.4 mmol/L。其他记录项目（您的原文）：“椰浆饭”和“拉茶”。",
      "p11.explain-pattern.zh-sg.abstention": "记录的日期为 2026年9月28日和 2026年10月1日。",
    };
    for (const [id, text] of Object.entries(expected)) {
      const result = await service.execute(planOf(id).request);
      expect(result.kind === "COMPOSED" && result.source === "AI" ? (result.composition.output.payload as { observation: { text: string } }).observation.text : null, id).toBe(text);
      expect(text).not.toMatch(/\b(?:for|alongside|noted|linked|because)\b|对应|由于/);
    }
  });
});

describe("observation ownership: harness and review (packet11-eval.17)", () => {
  it("each fixture records observationSource; language presence counts only the model-written fields", async () => {
    const fixtures = [...EXPLAIN.slice(0, 4), ...CARE.slice(0, 2)];
    const report = await evaluateHybridModelSnapshot({ model: { requestModelId: "fake-model", responseModelSnapshot: "fake-model" }, provider: echoing(), fixtures, phase: "FULL", limits: { maxCalls: 10, maxCredits: 1, allowRepair: false }, now: () => "2026-10-07T10:00:00.000Z", monotonicMs: () => 0 });
    expect(report.reportVersion).toBe("packet11-eval.18");
    for (const item of report.fixtures) {
      expect(item.source, item.fixtureId).toBe("AI");
      expect(item.observationSource).toBe(item.taskType === "EXPLAIN_PATTERN" ? "DETERMINISTIC" : null);
      if (item.taskType === "EXPLAIN_PATTERN") expect([item.presenceGroups, item.presenceGroupsWithLanguage], item.fixtureId).toEqual([2, 2]);
    }
    expect(report.languagePresence.passed).toBe(true);
  });
  it("the review page labels the observation as deterministic composition and the headline and evidence as AI wording", () => {
    const fixture = EXPLAIN.find((entry) => entry.id === "p11.explain-pattern.en-sg.forbidden-cause")!;
    const { plan } = planOf(fixture.id);
    const artifact = buildHybridHumanReview([{ fixture, candidate: shellCandidate(plan, remoteDefaults(plan)) }], { generatedAt: "2026-10-07T10:00:00.000Z" });
    expect(artifact.included).toBe(1);
    const blocks = artifact.items[0]!.blocks;
    const byPath = (path: string) => blocks.find((block) => block.path === path)!;
    expect(new Set(byPath("observation").pieces.map((piece) => piece.kind))).toEqual(new Set(["APPROVED", "FACT"]));
    expect(byPath("observation").label).toBe("Observation (deterministic composition)");
    expect(byPath("headline").pieces.some((piece) => piece.kind === "AI")).toBe(true);
    expect(byPath("evidence").pieces.some((piece) => piece.kind === "AI")).toBe(true);
    expect(artifact.html).toContain("Your records list");
  });
});

describe("observation ownership: versions", () => {
  it("moves exactly the pins the brief names", () => {
    expect(SHELL_INPUT_VERSIONS).toEqual({ EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" });
    expect(SHELL_OUTPUT_VERSIONS).toEqual({ EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" });
    // Packet 11C Task 4 (2026-10-08): application-only copy 11b.9 and default shells 11b.8; every model-facing pin is unchanged.
    // Packet 11C phase 2 (option (a), 2026-10-08): slot plan 11b.9 (eligibility accounting) and atoms 11b.7 (PERIOD_SUMMARY, lead joiner).
    expect(AI_HYBRID_VERSIONS).toMatchObject({ slotPlan: "ai-slot-plan.11b.9", atomRenderer: "ai-atoms.11b.7", defaultShells: "ai-shells-default.11b.8", shellRules: "ai-shell-rules.11b.15-r8", languageCopy: "ai-language-copy.11b.9", prompt: "11b.18", providerSchema: "kie-schema.11b.6", validatorRules: "11b.2-meaning-r7", fixtureSet: "packet11-fixtures.11b.16", evaluationReport: "packet11-eval.18", shellRequest: "ai-shell-request.11b.11" });
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey).toBe("ai.explain-pattern@11b.18");
    expect(AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey).toBe("ai.draft-care-preparation-summary@11b.18");
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      expect(AI_HYBRID_RUNTIME_BUNDLES[task].validatorProfile.version).toBe("11b.18");
      expect(AI_HYBRID_RUNTIME_BUNDLES[task].promptTemplate.version).toBe("11b.18");
      expect(AI_HYBRID_RUNTIME_BUNDLES[task].fixtureSet.version).toBe("11b.16");
    }
  });
  it("prompt 11b.18: the EXPLAIN text asks only for the headline and the evidence; the care prompts are byte-identical", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const text = shellPromptFor("EXPLAIN_PATTERN", locale)!.text;
      expect(text.toLowerCase()).not.toContain("observation");
      expect(text).toContain("Write a headline and an evidence sentence.");
      expect(text).toContain("Never link slots to each other");
      expect(text).toContain("Vary your wording naturally");
    }
  });
});
