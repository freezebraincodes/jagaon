// @vitest-environment node
import { rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { remoteFields, remoteTokenInventory, SHELL_MAX_OUTPUT_TOKENS, SHELL_OUTPUT_VERSIONS, SHELL_TEMPERATURE, type ShellTexts } from "@/domain/ai";
import { DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { readFile } from "node:fs/promises";
import * as hybridDiagnostic from "./packet-11-hybrid-live-diagnostic";
import { APPROVED_HYBRID_CONTRACT, HYBRID_FULL_EVALUATION_POLICY, AI_HYBRID_EVALUATION_REPORT_VERSION, evaluateHybridModelSnapshot, hybridLiveRunVerdict } from "./packet-11-hybrid-evaluation";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURE_SET_REVISION, PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import {
  checkHybridShellRequestBody,
  createHybridDiagnosticTracer,
  estimateMaxUsd,
  PACKET_11_HYBRID_TRACE_ROOT,
  sweepShellCandidate,
  verifyTraceRedaction,
} from "./packet-11-hybrid-live-diagnostic";
import { plannedFixture, shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Packet 11B.8 traced hybrid shell diagnostic (owner approval 2026-10-06: exactly one call). The offline part
 * always runs with fake fetchers only (no network, key or spend). The live part is skipped unless
 * RUN_LIVE_HYBRID_SHELL_DIAGNOSTIC=1 and is refused before any request unless every one of these holds:
 * HYBRID_DIAGNOSTIC_PROVIDER=deepseek, HYBRID_DIAGNOSTIC_MODEL=deepseek-flash, HYBRID_DIAGNOSTIC_FIXTURE_ID is the
 * ordinary EXPLAIN en-SG fixture, HYBRID_DIAGNOSTIC_CONFIRM_MAX_CALLS=1, 0 < HYBRID_DIAGNOSTIC_MAX_USD <= 0.01,
 * HYBRID_DIAGNOSTIC_RAW_TRACE=1, DEEPSEEK_API_KEY configured (server environment from the ignored .env.local), the
 * exact hybrid contract below, and an offline preflight of the exact request body that is value-blind and whose
 * upper-bound cost estimate is within the ceiling. No retry or repair, no listing or balance query, production
 * timeouts unchanged. Prints only closed codes, counts, versions, timings, spend and trace file paths.
 * Packet 11B.9: the required contract is bundle set 11b.9, packet11-fixtures.11b.7, packet11-eval.7 and request profile
 * ai-shell-request.11b.9 with max_output_tokens 512; the verdict is judged against the approved deepseek-flash.
 * Packet 11B.10: the required contract is bundle set 11b.10, packet11-fixtures.11b.8, packet11-eval.8 and request profile
 * ai-shell-request.11b.10 with per-task caps (EXPLAIN 512, care 1024); the preflight requires the fixture task's cap.
 * Rules r4 (Packet 11B.11, offline only): the required contract is prompt 11b.14, rules ai-shell-rules.11b.11-r4, bundle set
 * 11b.11, packet11-fixtures.11b.9 and packet11-eval.9; request profile and caps unchanged. The sweep also reports the r4
 * meaningful-wording and register checks per field. The live block is not run by this revision.
 * Rules r5 (Packet 11B.12, offline only): the required contract is prompt 11b.15, rules ai-shell-rules.11b.12-r5, bundle set
 * 11b.12, packet11-fixtures.11b.10 and packet11-eval.10; request profile and caps unchanged. The sweep also reports the r5
 * clinical-label category per field (and the authoritative S6b category). The live block is not run by this revision.
 * Rules r6 (Packet 11B.13, offline only): the required contract is prompt 11b.15 (unchanged), rules ai-shell-rules.11b.13-r6,
 * bundle set 11b.13, packet11-fixtures.11b.11 and packet11-eval.11; request profile and caps unchanged. The live block is not
 * run by this revision.
 * Rules r7 (Packet 11B.14, offline only): the required contract is prompt 11b.15 (unchanged), rules ai-shell-rules.11b.14-r7,
 * bundle set 11b.14, packet11-fixtures.11b.12, packet11-eval.12 and request profile ai-shell-request.11b.11 with temperature 0.2
 * (caps unchanged); the preflight requires temperature exactly 0.2 (TEMPERATURE_NOT_APPROVED otherwise) and the request trace
 * records it. The live block is not run by this revision.
 * FULL policy (packet11-eval.13, owner instruction 2026-10-07, offline only): the required contract adds harness packet11-eval.13
 * and fullEvaluationPolicy hybrid-full-policy.1; the diagnostic phase stays strict. The live block is not run by this revision.
 * Rules r8 (packet11-eval.14, owner instruction 2026-10-07, offline only): the required contract is rules 11b.15-r8, bundle set
 * 11b.15, fixtures 11b.13 and harness eval.14; the sweep's per-field directive flag reads S6's provenance-aware scan. The live
 * block is not run by this revision.
 * zh EXPLAIN guidance (packet11-eval.15, owner instruction 2026-10-07, offline only): the required contract is prompt 11b.16 (one
 * new paragraph in the zh-SG EXPLAIN asset only), bundle set 11b.16, fixtures 11b.14 and harness eval.15; rules r8 and everything
 * else are unchanged. The live block is not run by this revision.
 * en EXPLAIN guidance (packet11-eval.16, owner instruction 2026-10-07, offline only): the required contract is prompt 11b.17 (the
 * English counterpart, one new paragraph in the en-SG EXPLAIN asset only), bundle set 11b.17, fixtures 11b.15 and harness eval.16;
 * everything else is unchanged. The live block is not run by this revision.
 * Observation ownership (packet11-eval.17, owner instruction 2026-10-07, offline only): the required contract is prompt 11b.18,
 * kie-schema.11b.6, ai-slot-plan.11b.8, bundle set 11b.18, fixtures 11b.16 and harness eval.17; the model writes the EXPLAIN headline
 * and evidence only and the application composes the observation. Rules r8, the policy, request profile, caps and temperature are
 * unchanged. The live block is not run by this revision.
 */

const EN_ORDINARY = "p11.explain-pattern.en-sg.ordinary";
const CARE_ORDINARY = "p11.draft-care-preparation-summary.en-sg.ordinary";
/** Observation ownership: the only model-written field with two tokens is the care appointment bullet of this fixture. */
const TWO_TOKEN = "p11.draft-care-preparation-summary.en-sg.hidden-limitation";
const SENTINEL = "ds-SENTINEL-CREDENTIAL-5c0ffee1d2";
const NOW = () => "2026-10-06T06:00:00.000Z";
const REQUIRED_CONTRACT = Object.freeze({
  prompt: "11b.18",
  shellRules: "ai-shell-rules.11b.15-r8",
  providerSchema: "kie-schema.11b.6",
  explainBundle: "ai.explain-pattern@11b.18",
  careBundle: "ai.draft-care-preparation-summary@11b.18",
  // Packet 11C phase 2 (option (a), 2026-10-08, offline): eligibility accounting only; request bodies differ only in this version field.
  slotPlan: "ai-slot-plan.11b.9",
  fixtureSet: "packet11-fixtures.11b.16",
  harness: "packet11-eval.18",
  fullEvaluationPolicy: "hybrid-full-policy.2",
  shellRequest: "ai-shell-request.11b.11",
  maxOutputTokens: Object.freeze({ EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 }),
  temperature: 0.2,
});
const created = new Set<string>();
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
const fixtureById = (id: string) => PACKET_11_HYBRID_FIXTURES.find((fixture) => fixture.id === id)!;
const defaultTexts = (id: string): ShellTexts => defaultShells(plannedFixture(id).plan);
function envelope(candidate: unknown, overrides: Record<string, unknown> = {}): Response {
  const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
  return new Response(
    JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1400, output_tokens: 90, output_tokens_details: { reasoning_tokens: 0 } }, ...overrides }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
/** The exact body the shared adapter would send, captured offline: the fetcher records it and never transmits. */
async function captureBody(fixtureId: string): Promise<string> {
  let body: string | null = null;
  const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: async (_url, init) => {
    body = String(init.body);
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(projectShellTaskRequest(plannedFixture(fixtureId).plan), new AbortController().signal);
  if (body === null) throw new Error("NO_BODY_CAPTURED");
  return body;
}

describe("Packet 11 hybrid shell diagnostic (offline)", () => {
  it("rules r5: the required contract literal equals the current code pins (checked offline; the live block is not run)", () => {
    const code = {
      prompt: AI_HYBRID_VERSIONS.prompt,
      shellRules: AI_HYBRID_VERSIONS.shellRules,
      providerSchema: AI_HYBRID_VERSIONS.providerSchema,
      explainBundle: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey,
      careBundle: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey,
      slotPlan: AI_HYBRID_VERSIONS.slotPlan,
      fixtureSet: PACKET_11_HYBRID_FIXTURE_SET_REVISION,
      harness: AI_HYBRID_EVALUATION_REPORT_VERSION,
      fullEvaluationPolicy: HYBRID_FULL_EVALUATION_POLICY,
      shellRequest: AI_HYBRID_VERSIONS.shellRequest,
      maxOutputTokens: SHELL_MAX_OUTPUT_TOKENS,
      temperature: SHELL_TEMPERATURE,
    };
    expect(JSON.parse(JSON.stringify(REQUIRED_CONTRACT))).toEqual(JSON.parse(JSON.stringify(code)));
    expect(REQUIRED_CONTRACT).toMatchObject({ prompt: "11b.18", shellRules: "ai-shell-rules.11b.15-r8", explainBundle: "ai.explain-pattern@11b.18", careBundle: "ai.draft-care-preparation-summary@11b.18", fixtureSet: "packet11-fixtures.11b.16", harness: "packet11-eval.18", fullEvaluationPolicy: "hybrid-full-policy.2", shellRequest: "ai-shell-request.11b.11", temperature: 0.2 });
    // Rules r7: the approved hybrid contract carries the same temperature.
    expect(APPROVED_HYBRID_CONTRACT.shellTemperature).toBe(REQUIRED_CONTRACT.temperature);
  });
  it("builds a value-blind request for the ordinary EXPLAIN en-SG fixture: approved slot IDs, kinds, glosses and fixed budgets only", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const check = checkHybridShellRequestBody(fixture, await captureBody(EN_ORDINARY), "deepseek-flash");
    expect(check.violations).toEqual([]);
    expect(check.passed).toBe(true);
    const plan = plannedFixture(EN_ORDINARY).plan;
    // Observation ownership: only the model's fields (headline, evidence), their slots and budgets; never the observation.
    expect(check.summary.tokenInventory).toEqual(remoteTokenInventory(plan));
    expect(check.summary.tokenInventory).toEqual(["S1", "S3"]);
    expect(check.summary.slots.map((slot) => slot.slotId)).toEqual(remoteTokenInventory(plan));
    expect(check.summary.slots.every((slot) => slot.glossKey !== null)).toBe(true);
    expect(check.summary.fields.map((field) => [field.path, field.maxCodePoints, field.maxSentences])).toEqual(remoteFields(plan).map((field) => [field.path, field.maxCodePoints, field.maxSentences]));
    expect(check.summary.fixtureStringsScanned).toBeGreaterThan(0);
    expect(check.summary.fixtureValuesFound).toBe(0);
    expect(check.summary.versions.shellSchemaVersion).toBe(SHELL_OUTPUT_VERSIONS.EXPLAIN_PATTERN);
  });

  it("flags a body carrying a fixture value, a date, a stored request or an unapproved string", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const body = JSON.parse(await captureBody(EN_ORDINARY)) as { store: boolean; input: Array<{ content: Array<{ text: string }> }> };
    const shell = JSON.parse(body.input[0]!.content[0]!.text) as { slots: Array<{ gloss: string }> };
    const atom = Object.values(plannedFixture(EN_ORDINARY).atoms).find((entry) => entry && entry.text.length >= 3)!.text;
    const withGloss = (gloss: string) => {
      const copy = structuredClone(body);
      const inner = structuredClone(shell);
      inner.slots[0]!.gloss = gloss;
      copy.input[0]!.content[0]!.text = JSON.stringify(inner);
      return JSON.stringify(copy);
    };
    expect(checkHybridShellRequestBody(fixture, withGloss(atom), "deepseek-flash").violations).toEqual(expect.arrayContaining(["FIXTURE_VALUE_PRESENT", "UNAPPROVED_STRING", "INPUT_NOT_FIXTURE_PROJECTION"]));
    expect(checkHybridShellRequestBody(fixture, withGloss("recorded on 2026-09-01"), "deepseek-flash").violations).toEqual(expect.arrayContaining(["DATE_PATTERN_PRESENT", "UNAPPROVED_STRING"]));
    expect(checkHybridShellRequestBody(fixture, JSON.stringify({ ...body, store: true }), "deepseek-flash").violations).toContain("STORE_NOT_FALSE");
    expect(checkHybridShellRequestBody(fixture, JSON.stringify(body), "deepseek-chat").violations).toEqual(["BODY_MODEL"]);
  });

  it("refuses a non-value-blind body, a second transmission and any other endpoint unsent; redacts the credential", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    let sent = 0;
    const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
      sent += 1;
      return envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY)));
    } });
    created.add(tracer.directory);
    const body = await captureBody(EN_ORDINARY);
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    await expect(tracer.fetcher("https://api.kie.ai/v1/responses", { method: "POST", headers, body })).rejects.toThrow("TRACE_ENDPOINT_NOT_ALLOWED");
    expect(sent).toBe(0);

    const second = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
      sent += 1;
      return envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY)));
    } });
    created.add(second.directory);
    await expect(second.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: body.replace("\"store\":false", "\"store\":true") })).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
    expect(sent).toBe(0);

    const third = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
      sent += 1;
      return envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY)));
    } });
    created.add(third.directory);
    expect((await third.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).status).toBe(200);
    await expect(third.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).rejects.toThrow("TRACE_CALL_LIMIT");
    expect(sent).toBe(1);
    expect(third.files()).toHaveLength(2);
    const redaction = await verifyTraceRedaction(third.files(), SENTINEL);
    expect(redaction).toEqual({ filesChecked: 2, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(statSync(third.directory).mode & 0o777).toBe(0o700);
    expect(relative(process.cwd(), third.directory).startsWith(PACKET_11_HYBRID_TRACE_ROOT)).toBe(true);
  });

  it("rules r8: the per-field directive flag reads S6's provenance-aware scan (a stand-in collision is no directive; a model-written token split is)", () => {
    // Observation ownership: the cases are written in model fields (the zh evidence; the care appointment bullet for two tokens).
    const sweepZh = (id: string, path: string, text: string) => {
      const own = plannedFixture(id).plan;
      const merged = new Map(defaultTexts(id));
      merged.set(path as never, text);
      return sweepShellCandidate(fixtureById(id), shellCandidate(own, merged));
    };
    const fieldOf = (result: ReturnType<typeof sweepShellCandidate>, path: string) => result.fields.find((entry) => entry.path === path)!;
    const BULLET = "sections[0].bullets[0]";
    const collision = sweepZh("p11.draft-care-preparation-summary.zh-sg.hidden-limitation", BULLET, "数值为{{S1}}，相应{{S2}}的项目如下。");
    expect(fieldOf(collision, BULLET).directive).toBe(false);
    expect(collision.authoritative).toMatchObject({ verdict: "ACCEPTED", gate: null });
    const split = sweepZh("p11.explain-pattern.zh-sg.ordinary", "evidence", "应{{S3}}该记录。");
    expect(fieldOf(split, "evidence").directive).toBe(true);
    expect(split.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" });
    const plain = sweepZh("p11.explain-pattern.zh-sg.ordinary", "evidence", "应该记录{{S3}}。");
    expect(fieldOf(plain, "evidence").directive).toBe(true);
    expect(plain.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S6" });
  });
  it("classifies every token, budget, presence, lexical and directive check independently", () => {
    const fixture = fixtureById(EN_ORDINARY);
    const plan = plannedFixture(EN_ORDINARY).plan;
    const texts = new Map(defaultTexts(EN_ORDINARY));
    const ok = sweepShellCandidate(fixture, shellCandidate(plan, texts));
    expect(ok.authoritative.verdict).toBe("ACCEPTED");
    expect(ok.fields.every((field) => field.tokens === "EXACT" && field.budget === "WITHIN" && field.lexical.length === 0 && !field.directive)).toBe(true);
    expect([ok.schema, ok.tokenInventoryEcho, ok.slotPlanVersionEcho, ok.assembly, ok.r7, ok.atomEqual]).toEqual(["PASSED", true, true, "ASSEMBLED", "ACCEPTED", true]);
    const sweep = (overrides: Record<string, string>, id = EN_ORDINARY) => {
      const own = plannedFixture(id).plan;
      const merged = new Map(defaultTexts(id));
      for (const [path, text] of Object.entries(overrides)) merged.set(path as never, text);
      return sweepShellCandidate(fixtureById(id), shellCandidate(own, merged));
    };
    const field = (result: ReturnType<typeof sweep>, path: string) => result.fields.find((entry) => entry.path === path)!;
    // Observation ownership (eval.17): the sweep reads the model's fields only; a candidate carrying an observation fails the schema.
    expect(ok.fields.map((entry) => entry.path)).toEqual(["headline", "evidence"]);
    const withObservation = { ...shellCandidate(plan, texts), shells: { ...(shellCandidate(plan, texts) as { shells: object }).shells, observation: "Your records show {{S2}}." } };
    expect(sweepShellCandidate(fixture, withObservation)).toMatchObject({ schema: "FAILED", authoritative: { verdict: "REJECTED", gate: "S2", reason: "SCHEMA_INVALID" }, assembly: "NOT_REACHED" });
    expect(field(sweep({ evidence: "This is based on." }), "evidence").tokens).toBe("MISSING");
    expect(field(sweep({ evidence: "This is based on {{S3}} and {{S3}}." }), "evidence").tokens).toBe("DUPLICATE");
    expect(field(sweep({ evidence: "This is based on {{S2}}." }), "evidence").tokens).toBe("STRAY");
    expect(field(sweep({ evidence: "This is based on {{ S3 }}." }), "evidence").tokens).toBe("MALFORMED");
    expect(field(sweep({ "sections[0].bullets[0]": "{{S2}}, {{S1}}" }, TWO_TOKEN), "sections[0].bullets[0]").tokens).toBe("REORDERED");
    expect(field(sweep({ evidence: "Fifty values: {{S3}}." }), "evidence").lexical).toContain("NUMBER_WORD");
    expect(field(sweep({ evidence: "Pl ease note {{S3}}." }), "evidence").directive).toBe(true);
    const empty = sweep({ headline: "{{S1}} ~" });
    expect(empty.presenceGroups.find((group) => group.paths.includes("headline"))!.satisfied).toBe(false);
    // Rules r4: per-field meaningful wording and register, reported independently; eval.17: the groups are the model's EXPLAIN fields.
    expect(ok.presenceGroups.map((group) => [group.paths, group.satisfied])).toEqual([[["headline"], true], [["evidence"], true]]);
    expect(ok.fields.every((entry) => entry.meaningfulWording && entry.register === null)).toBe(true);
    expect(ok.authoritative.register).toBeNull();
    const short = sweep({ headline: "See {{S1}}.", evidence: "Just {{S3}}." });
    expect([field(short, "headline").languagePresent, field(short, "headline").meaningfulWording, field(short, "evidence").meaningfulWording]).toEqual([true, false, false]);
    expect(short.presenceGroups.map((group) => group.satisfied)).toEqual([false, false]);
    expect(short.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED", register: null, quality: { code: "NOT_MEANINGFUL", fieldKind: "headline" } });
    expect(ok.authoritative.quality).toBeNull();
    const ZH_ORDINARY = "p11.explain-pattern.zh-sg.ordinary";
    const informal = sweep({ headline: "这里是您记录的{{S1}}。", evidence: "你的记录基于{{S3}}。" }, ZH_ORDINARY);
    expect([field(informal, "evidence").register, field(informal, "headline").register, field(informal, "evidence").meaningfulWording]).toEqual(["INFORMAL_SECOND_PERSON", null, true]);
    expect(informal.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S7", reason: "LOCALE_INVALID", register: "INFORMAL_SECOND_PERSON" });
    const care = sweep({ "sections[0].intro": "Okay, so." }, CARE_ORDINARY);
    expect(care.presenceGroups[0]).toEqual({ paths: ["sections[0].intro"], satisfied: false });
    expect(care.fields.filter((entry) => entry.path.includes("bullets")).every((entry) => !entry.meaningfulWording)).toBe(true);
    // Rules r5: the clinical-label category per field, reported independently, and the authoritative S6b category.
    expect(ok.fields.every((entry) => entry.clinicalLabel === null)).toBe(true);
    expect(ok.authoritative.clinicalLabel).toBeNull();
    const clinical = sweep({ headline: "A medication look at {{S1}}.", evidence: "Your diabetes notes show {{S3}}." });
    expect([field(clinical, "headline").clinicalLabel, field(clinical, "evidence").clinicalLabel]).toEqual(["MEDICATION", "DISEASE_OR_CONDITION"]);
    expect(clinical.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S6b", reason: "CLINICAL_MEANING_VIOLATION", clinicalLabel: "MEDICATION", register: null, quality: null });
    // A field caught earlier (S5) still reports its clinical-label category independently.
    const earlier = sweep({ evidence: "Your diabetes notes rose: {{S3}}." });
    expect(field(earlier, "evidence").clinicalLabel).toBe("DISEASE_OR_CONDITION");
    expect(earlier.authoritative).toMatchObject({ gate: "S5", clinicalLabel: null });
    const zhClinical = sweep({ "sections[0].intro": "您選擇加入的藥物記錄如下。" }, "p11.draft-care-preparation-summary.zh-sg.ordinary");
    expect(field(zhClinical, "sections[0].intro").clinicalLabel).toBe("MEDICATION");
    expect(zhClinical.authoritative).toMatchObject({ gate: "S6b", clinicalLabel: "MEDICATION" });
    expect(field(informal, "evidence").clinicalLabel).toBeNull();
    // r6 fix round 2: the per-field category reads the text as S6b does (tokens as CLINICAL_TOKEN_SEPARATOR), so a neutral phrase
    // split by a slot token is not neutral and the standalone label is reported, consistently with the authoritative verdict.
    const tokenSplit = sweep({ evidence: "Your medical {{S3}} team notes." });
    expect(field(tokenSplit, "evidence").clinicalLabel).toBe("CLINICAL_LABEL");
    expect(tokenSplit.authoritative).toMatchObject({ verdict: "REJECTED", gate: "S6b", clinicalLabel: "CLINICAL_LABEL" });
    const neutral = sweep({ evidence: "Your medical team notes show {{S3}}." });
    expect(field(neutral, "evidence").clinicalLabel).toBeNull();
    expect(neutral.authoritative.clinicalLabel).toBeNull();
    expect(sweepShellCandidate(fixture, "{not json").candidateKind).toBe("UNPARSED_TEXT");
    expect(sweepShellCandidate(fixture, { ...shellCandidate(plan, texts), tokenInventory: ["S3", "S1"] }).tokenInventoryEcho).toBe(false);
    // The full plan inventory (with the application-owned observation slot) is not the remote inventory.
    expect(sweepShellCandidate(fixture, { ...shellCandidate(plan, texts), tokenInventory: ["S1", "S2", "S3"] }).tokenInventoryEcho).toBe(false);
  });

  it("runs one traced call end to end through the hybrid harness with a fake DeepSeek response", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY))) });
    created.add(tracer.directory);
    const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: tracer.fetcher });
    const report = await evaluateHybridModelSnapshot({ model: deepSeekFlash(), provider, fixtures: hybridFixturesForPhase("DIAGNOSTIC", EN_ORDINARY), phase: "DIAGNOSTIC", limits: { maxCalls: 1, maxCredits: 0.01, allowRepair: false }, now: NOW });
    expect(report.totals.calls).toBe(1);
    expect(report.fixtures[0]).toMatchObject({ source: "AI", outcome: "ACCEPTED", retention: "CONFIRMED_NOT_STORED", responseModel: "deepseek-flash", atomEqual: true, presenceGroups: 2, presenceGroupsWithLanguage: 2, observationSource: "DETERMINISTIC" });
    expect(tracer.transmissions()).toHaveLength(1);
    expect(tracer.checks().every((check) => check.passed)).toBe(true);
    expect((await verifyTraceRedaction(tracer.files(), SENTINEL)).secretAbsent).toBe(true);
    // eval.7: the real DeepSeek shell adapter (fake response) with the approved model, provider and endpoint can PASS.
    expect(report.provider).toEqual({ providerKey: "deepseek", endpoint: DEEPSEEK_RESPONSES_URL });
    expect(report.versions).toMatchObject({ shellRequestVersion: "ai-shell-request.11b.11", shellMaxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 }, shellTemperature: 0.2 });
    expect(hybridLiveRunVerdict(report, { phase: "DIAGNOSTIC", fixtureIds: [EN_ORDINARY], maxCalls: 1 }, { maxCredits: 0.01, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot }, null)).toEqual({ kind: "PASS" });
  });

  it("11b.9: the preflight requires max_output_tokens exactly 512 and the tracer refuses any other value unsent", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const captured = await captureBody(EN_ORDINARY);
    const body = JSON.parse(captured) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(SHELL_MAX_OUTPUT_TOKENS.EXPLAIN_PATTERN);
    expect(checkHybridShellRequestBody(fixture, captured, "deepseek-flash").violations).toEqual([]);
    const without = { ...body };
    delete without.max_output_tokens;
    const variants: ReadonlyArray<readonly [string, string]> = [
      ["missing", JSON.stringify(without)],
      ["null", JSON.stringify({ ...body, max_output_tokens: null })],
      ["4096", JSON.stringify({ ...body, max_output_tokens: 4096 })],
      ["string", JSON.stringify({ ...body, max_output_tokens: "512" })],
      ["511", JSON.stringify({ ...body, max_output_tokens: 511 })],
      // 11b.10: the care cap is not the EXPLAIN cap.
      ["care cap 1024", JSON.stringify({ ...body, max_output_tokens: 1024 })],
    ];
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    for (const [label, variant] of variants) {
      expect(checkHybridShellRequestBody(fixture, variant, "deepseek-flash").violations, label).toContain("MAX_OUTPUT_TOKENS_NOT_APPROVED");
      let sent = 0;
      const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
        sent += 1;
        return envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY)));
      } });
      created.add(tracer.directory);
      await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: variant }), label).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
      expect(sent, label).toBe(0);
      expect(tracer.files(), label).toEqual([]);
    }
  });

  it("11b.10: the pre-call estimate uses the task's cap (EXPLAIN 512, care 1024), not an assumed 4096", () => {
    expect(hybridDiagnostic).not.toHaveProperty("HYBRID_DIAGNOSTIC_ASSUMED_MAX_OUTPUT_TOKENS");
    for (const [task, cap] of [["EXPLAIN_PATTERN", 512], ["DRAFT_CARE_PREPARATION_SUMMARY", 1024]] as const) {
      const estimate = estimateMaxUsd(10_000, task);
      expect(estimate.outputTokensMax, task).toBe(cap);
      expect(estimate.outputTokensMax, task).toBe(SHELL_MAX_OUTPUT_TOKENS[task]);
      expect(estimate, task).not.toHaveProperty("outputTokensAssumedMax");
      const micro = estimate.inputTokensUpperBound * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + cap * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output;
      expect(estimate.estimatedMaxUsd, task).toBe(Math.ceil(micro) / 1_000_000);
    }
    expect(estimateMaxUsd(10_000, "DRAFT_CARE_PREPARATION_SUMMARY").estimatedMaxUsd).toBeGreaterThan(estimateMaxUsd(10_000, "EXPLAIN_PATTERN").estimatedMaxUsd);
    expect(() => estimateMaxUsd(10_000, "EXTRACT_CANDIDATE_FACTS" as never)).toThrow("UNKNOWN_SHELL_TASK");
  });

  it("11b.10: a care body must carry 1024; 512 or any other value is refused unsent", async () => {
    const fixture = fixtureById(CARE_ORDINARY);
    const captured = await captureBody(CARE_ORDINARY);
    const body = JSON.parse(captured) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(1024);
    // Fix round 1: the real care body passes the whole preflight with its own task cap.
    expect(checkHybridShellRequestBody(fixture, captured, "deepseek-flash").violations).toEqual([]);
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    for (const wrong of [512, 2048, null, "1024"]) {
      const variant = JSON.stringify({ ...body, max_output_tokens: wrong });
      expect(checkHybridShellRequestBody(fixture, variant, "deepseek-flash").violations, String(wrong)).toEqual(["MAX_OUTPUT_TOKENS_NOT_APPROVED"]);
      let sent = 0;
      const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
        sent += 1;
        return envelope("{}");
      } });
      created.add(tracer.directory);
      await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: variant }), String(wrong)).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
      expect(sent, String(wrong)).toBe(0);
    }
    // An EXPLAIN body (cap 512) checked against the care fixture fails the cap check too.
    expect(checkHybridShellRequestBody(fixture, await captureBody(EN_ORDINARY), "deepseek-flash").violations).toContain("MAX_OUTPUT_TOKENS_NOT_APPROVED");
  });

  it("11b.10 fix round 1: every one of the 70 hybrid fixtures' real body passes the preflight with its own task cap", async () => {
    expect(PACKET_11_HYBRID_FIXTURES).toHaveLength(70);
    const tasks = new Set<string>();
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const captured = await captureBody(fixture.id);
      expect((JSON.parse(captured) as { max_output_tokens: unknown }).max_output_tokens, fixture.id).toBe(SHELL_MAX_OUTPUT_TOKENS[fixture.taskType as "EXPLAIN_PATTERN"]);
      const check = checkHybridShellRequestBody(fixture, captured, "deepseek-flash");
      expect(check.violations, fixture.id).toEqual([]);
      expect(check.summary.fixtureStringsScanned, fixture.id).toBeGreaterThan(0);
      tasks.add(fixture.taskType);
    }
    expect([...tasks].sort()).toEqual(["DRAFT_CARE_PREPARATION_SUMMARY", "EXPLAIN_PATTERN"]);
  });

  it("11b.10 fix round 1: a real care fact value, text, unit or date injected into a gloss is still FIXTURE_VALUE_PRESENT", async () => {
    const injectedKeys = new Set<string>();
    const careFixtures = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.taskType === "DRAFT_CARE_PREPARATION_SUMMARY");
    for (const fixture of careFixtures) {
      const body = JSON.parse(await captureBody(fixture.id)) as { input: Array<{ content: Array<{ text: string }> }> };
      const shell = JSON.parse(body.input[0]!.content[0]!.text) as { slots: Array<{ gloss: string }> };
      for (const fact of (fixture.request as unknown as { facts: Array<{ value: Record<string, unknown> }> }).facts) {
        for (const [key, value] of Object.entries(fact.value)) {
          // The schema-closed kind and the request locale are not fixture data; everything else is.
          if (key === "kind" || key === "language" || typeof value !== "string" || value.length < 3) continue;
          const copy = structuredClone(body);
          const inner = structuredClone(shell);
          inner.slots[0]!.gloss = `recorded ${value}`;
          copy.input[0]!.content[0]!.text = JSON.stringify(inner);
          expect(checkHybridShellRequestBody(fixture, JSON.stringify(copy), "deepseek-flash").violations, `${fixture.id} ${key}`).toContain("FIXTURE_VALUE_PRESENT");
          injectedKeys.add(key);
        }
      }
    }
    // Decimal values, units, patient text and dates were all exercised.
    expect([...injectedKeys]).toEqual(expect.arrayContaining(["value", "unit", "text", "localDate"]));
  });

  it("11b.10 fix round 1: a care tracer run with a fake fetcher writes a request trace recording maxOutputTokens 1024 and passes redaction", async () => {
    const fixture = fixtureById(CARE_ORDINARY);
    const body = await captureBody(CARE_ORDINARY);
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    let sent = 0;
    const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
      sent += 1;
      return envelope(shellCandidate(plannedFixture(CARE_ORDINARY).plan, defaultTexts(CARE_ORDINARY)), { usage: { input_tokens: 2000, output_tokens: 300 } });
    } });
    created.add(tracer.directory);
    expect((await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).status).toBe(200);
    expect(sent).toBe(1);
    expect(tracer.failure()).toBeNull();
    expect(tracer.files()).toHaveLength(2);
    const request = JSON.parse(await readFile(resolve(process.cwd(), tracer.files()[0]!), "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({ kind: "REQUEST", fixtureId: CARE_ORDINARY, maxOutputTokens: 1024, valueBlindness: { passed: true, violations: [] } });
    expect(await verifyTraceRedaction(tracer.files(), SENTINEL)).toEqual({ filesChecked: 2, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
  });

  it("11b.9: the request record carries maxOutputTokens; the response record and transmission carry the status and a closed incomplete-details flag", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const body = await captureBody(EN_ORDINARY);
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    const truncated = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope("{\"schemaVersion\":\"ai-shell.explain", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1400, output_tokens: 512 } }) });
    created.add(truncated.directory);
    await truncated.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
    expect(truncated.transmissions()[0]).toMatchObject({ status: "incomplete", incompleteDetailsPresent: true });
    const [requestFile, responseFile] = truncated.files();
    const request = JSON.parse(await readFile(resolve(process.cwd(), requestFile!), "utf8")) as Record<string, unknown>;
    const response = JSON.parse(await readFile(resolve(process.cwd(), responseFile!), "utf8")) as Record<string, unknown>;
    expect(request.maxOutputTokens).toBe(512);
    expect(response).toMatchObject({ status: "incomplete", incompleteDetailsPresent: true });

    const complete = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope(shellCandidate(plannedFixture(EN_ORDINARY).plan, defaultTexts(EN_ORDINARY)), { incomplete_details: null }) });
    created.add(complete.directory);
    await complete.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
    expect(complete.transmissions()[0]).toMatchObject({ status: "completed", incompleteDetailsPresent: false });
    const odd = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope("{}", { status: "Some free text <b>" }) });
    created.add(odd.directory);
    await odd.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
    // The printable status is a closed class, never the provider's raw string.
    expect(odd.transmissions()[0]).toMatchObject({ status: "OTHER", incompleteDetailsPresent: false });
  });

  it("r7: the preflight requires temperature exactly 0.2 (EXPLAIN and care) and the tracer refuses any other value unsent", async () => {
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    for (const id of [EN_ORDINARY, CARE_ORDINARY]) {
      const fixture = fixtureById(id);
      const captured = await captureBody(id);
      const body = JSON.parse(captured) as Record<string, unknown>;
      expect(body.temperature, id).toBe(0.2);
      expect(checkHybridShellRequestBody(fixture, captured, "deepseek-flash").violations, id).toEqual([]);
      const without = { ...body };
      delete without.temperature;
      const variants: ReadonlyArray<readonly [string, string, readonly string[]]> = [
        ["missing", JSON.stringify(without), ["BODY_KEYS", "TEMPERATURE_NOT_APPROVED"]],
        ["null", JSON.stringify({ ...body, temperature: null }), ["TEMPERATURE_NOT_APPROVED"]],
        ["1", JSON.stringify({ ...body, temperature: 1 }), ["TEMPERATURE_NOT_APPROVED"]],
        ["1.0", JSON.stringify({ ...body, temperature: 1.0 }), ["TEMPERATURE_NOT_APPROVED"]],
        ["0", JSON.stringify({ ...body, temperature: 0 }), ["TEMPERATURE_NOT_APPROVED"]],
        ["0.3", JSON.stringify({ ...body, temperature: 0.3 }), ["TEMPERATURE_NOT_APPROVED"]],
        ["string", JSON.stringify({ ...body, temperature: "0.2" }), ["TEMPERATURE_NOT_APPROVED"]],
        ["object", JSON.stringify({ ...body, temperature: { value: 0.2 } }), ["TEMPERATURE_NOT_APPROVED"]],
        // A sampling key beside the approved temperature is an unapproved body key.
        ["top_p", JSON.stringify({ ...body, top_p: 0.1 }), ["BODY_KEYS"]],
      ];
      for (const [label, variant, expected] of variants) {
        expect(checkHybridShellRequestBody(fixture, variant, "deepseek-flash").violations, `${id} ${label}`).toEqual(expected);
        let sent = 0;
        const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => {
          sent += 1;
          return envelope("{}");
        } });
        created.add(tracer.directory);
        await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: variant }), `${id} ${label}`).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
        expect(sent, `${id} ${label}`).toBe(0);
        expect(tracer.files(), `${id} ${label}`).toEqual([]);
      }
    }
  });

  it("r7: every one of the 70 hybrid fixtures' real body carries temperature 0.2 and passes the preflight", async () => {
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const captured = await captureBody(fixture.id);
      expect((JSON.parse(captured) as { temperature: unknown }).temperature, fixture.id).toBe(0.2);
      expect(checkHybridShellRequestBody(fixture, captured, "deepseek-flash").violations, fixture.id).toEqual([]);
    }
  });

  it("r7: the request trace records temperature 0.2 beside maxOutputTokens (EXPLAIN and care)", async () => {
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    for (const [id, cap] of [[EN_ORDINARY, 512], [CARE_ORDINARY, 1024]] as const) {
      const fixture = fixtureById(id);
      const body = await captureBody(id);
      const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope(shellCandidate(plannedFixture(id).plan, defaultTexts(id))) });
      created.add(tracer.directory);
      expect((await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).status, id).toBe(200);
      const request = JSON.parse(await readFile(resolve(process.cwd(), tracer.files()[0]!), "utf8")) as Record<string, unknown>;
      expect(request, id).toMatchObject({ kind: "REQUEST", fixtureId: id, maxOutputTokens: cap, temperature: 0.2, body: { temperature: 0.2, max_output_tokens: cap }, valueBlindness: { passed: true, violations: [] } });
      expect(await verifyTraceRedaction(tracer.files(), SENTINEL), id).toEqual({ filesChecked: 2, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    }
  });

  it("11b.9: a truncated traced call falls back through the harness with its usage counted", async () => {
    const fixture = fixtureById(EN_ORDINARY);
    const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: async () => envelope("{\"schemaVersion\"", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1400, output_tokens: 512 } }) });
    created.add(tracer.directory);
    let last: KieProviderDiagnostic | null = null;
    const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: tracer.fetcher, onDiagnostic: (value) => (last = value) });
    const takeDiagnostic = () => { const taken = last; last = null; return taken; };
    const report = await evaluateHybridModelSnapshot({ model: deepSeekFlash(), provider, fixtures: hybridFixturesForPhase("DIAGNOSTIC", EN_ORDINARY), phase: "DIAGNOSTIC", limits: { maxCalls: 1, maxCredits: 0.01, allowRepair: false }, now: NOW, takeDiagnostic });
    expect(tracer.transmissions()).toHaveLength(1);
    expect(report.fixtures[0]).toMatchObject({ source: "DETERMINISTIC", reasonCode: "PROVIDER_FAILED", attempts: 1, inputTokens: 1400, outputTokens: 512 });
    // Fix round 1: the billed DeepSeek call counts at its USD estimate toward the ceiling.
    expect(report.totals.credits).toBeCloseTo(deepSeekCostMicroUsd(1400, 512) / 1_000_000, 6);
    expect(report.totals.credits).toBeGreaterThan(0);
    expect(hybridLiveRunVerdict(report, { phase: "DIAGNOSTIC", fixtureIds: [EN_ORDINARY], maxCalls: 1 }, { maxCredits: 0.01, requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" }, null).kind).toBe("FAIL");
  });
});

const env = process.env;
const LIVE = env.RUN_LIVE_HYBRID_SHELL_DIAGNOSTIC === "1";

describe.skipIf(!LIVE)("Packet 11 hybrid shell diagnostic (live, exactly one call)", () => {
  it(
    "sends exactly one traced value-blind shell request to direct DeepSeek",
    async () => {
      // Every refusal happens before any request.
      if (env.HYBRID_DIAGNOSTIC_PROVIDER !== "deepseek") throw new Error("HYBRID_DIAGNOSTIC_PROVIDER must be deepseek");
      if (env.HYBRID_DIAGNOSTIC_MODEL !== "deepseek-flash") throw new Error("HYBRID_DIAGNOSTIC_MODEL must be deepseek-flash");
      if (env.HYBRID_DIAGNOSTIC_FIXTURE_ID !== EN_ORDINARY) throw new Error(`HYBRID_DIAGNOSTIC_FIXTURE_ID must be ${EN_ORDINARY}`);
      if (env.HYBRID_DIAGNOSTIC_CONFIRM_MAX_CALLS !== "1") throw new Error("Set HYBRID_DIAGNOSTIC_CONFIRM_MAX_CALLS=1");
      if (env.HYBRID_DIAGNOSTIC_RAW_TRACE !== "1") throw new Error("HYBRID_DIAGNOSTIC_RAW_TRACE=1 is required");
      const maxUsd = Number(env.HYBRID_DIAGNOSTIC_MAX_USD);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 0.01) throw new Error("HYBRID_DIAGNOSTIC_MAX_USD must be in (0, 0.01]");
      const token = readDeepSeekToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("DEEPSEEK_API_KEY is not configured");
      if (Object.keys(env).some((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|TOKEN|SECRET/i.test(name))) throw new Error("PUBLIC_CREDENTIAL_NAME_PRESENT");

      const bundle = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
      const contract = {
        prompt: AI_HYBRID_VERSIONS.prompt,
        shellRules: AI_HYBRID_VERSIONS.shellRules,
        providerSchema: AI_HYBRID_VERSIONS.providerSchema,
        explainBundle: bundle.bundleKey,
        careBundle: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey,
        slotPlan: AI_HYBRID_VERSIONS.slotPlan,
        fixtureSet: PACKET_11_HYBRID_FIXTURE_SET_REVISION,
        harness: AI_HYBRID_EVALUATION_REPORT_VERSION,
        fullEvaluationPolicy: HYBRID_FULL_EVALUATION_POLICY,
        shellRequest: AI_HYBRID_VERSIONS.shellRequest,
        maxOutputTokens: SHELL_MAX_OUTPUT_TOKENS,
        temperature: SHELL_TEMPERATURE,
      };
      // Maps (the per-task caps) are compared by value.
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const contractMismatch = (Object.keys(REQUIRED_CONTRACT) as Array<keyof typeof REQUIRED_CONTRACT>).filter((key) => !same(contract[key], REQUIRED_CONTRACT[key]));
      const approvedMismatch = ([["promptVersion", contract.prompt], ["shellRulesRevision", contract.shellRules], ["providerSchemaVersion", contract.providerSchema], ["slotPlanVersion", contract.slotPlan], ["fixtureSetRevision", contract.fixtureSet], ["evaluationReportVersion", contract.harness], ["fullEvaluationPolicy", contract.fullEvaluationPolicy], ["explainBundle", contract.explainBundle], ["careBundle", contract.careBundle], ["shellRequestVersion", contract.shellRequest], ["shellMaxOutputTokens", contract.maxOutputTokens], ["shellTemperature", contract.temperature], ["requestModelId", "deepseek-flash"], ["responseModelSnapshot", "deepseek-flash"], ["providerKey", "deepseek"], ["endpoint", DEEPSEEK_RESPONSES_URL]] as const).filter(([key, value]) => !same(APPROVED_HYBRID_CONTRACT[key], value)).map(([key]) => key);
      if (contractMismatch.length > 0 || approvedMismatch.length > 0) throw new Error(`CONTRACT_MISMATCH:${[...contractMismatch, ...approvedMismatch].join(",")}`);
      const model = deepSeekFlash();
      if (model.endpoint !== DEEPSEEK_RESPONSES_URL || model.requestModelId !== "deepseek-flash" || model.responseModelSnapshot !== "deepseek-flash") throw new Error("MODEL_OR_ENDPOINT_NOT_APPROVED");
      const fixtures = hybridFixturesForPhase("DIAGNOSTIC", EN_ORDINARY);
      if (fixtures.length !== 1 || fixtures[0]!.id !== EN_ORDINARY) throw new Error("FIXTURE_SELECTION");
      const fixture = fixtures[0]!;

      // Offline preflight of the exact body (a capture-only fetcher; the real credential is not used).
      const preflight = checkHybridShellRequestBody(fixture, await captureBody(EN_ORDINARY), model.requestModelId);
      const estimate = estimateMaxUsd(preflight.summary.bodyByteCount, fixture.taskType as "EXPLAIN_PATTERN");
      console.log(JSON.stringify({ packet11HybridDiagnosticPlan: { provider: "deepseek", endpoint: model.endpoint, model: model.requestModelId, fixtureId: fixture.id, maxCalls: 1, maxUsd, allowRepair: false, perCallTimeoutMs: bundle.executionBudget.perCallTimeoutMs, overallTimeoutMs: bundle.executionBudget.overallTimeoutMs, contract, preflight: { passed: preflight.passed, violations: preflight.violations, summary: preflight.summary }, estimate } }));
      if (!preflight.passed) throw new Error(`PREFLIGHT_NOT_VALUE_BLIND:${preflight.violations.join(",")}`);
      if (estimate.estimatedMaxUsd > maxUsd) throw new Error("PREFLIGHT_ESTIMATE_OVER_CEILING");

      const tracer = await createHybridDiagnosticTracer({ fixture, expectedModel: model.requestModelId, maxTransmissions: 1, fetcher: (url, init) => fetch(url, init) });
      let lastDiagnostic: KieProviderDiagnostic | null = null;
      const inner = createDeepSeekShellResponsesProvider({ token: token.token, model, fetcher: tracer.fetcher, onDiagnostic: (diagnostic) => (lastDiagnostic = diagnostic) });
      let candidate: unknown = undefined;
      const provider: AiShellProviderPort = {
        providerModel: inner.providerModel,
        async invoke(input, signal) {
          const result = await inner.invoke(input, signal);
          if (result.kind === "COMPLETED") candidate = result.candidate;
          return result;
        },
      };
      const takeDiagnostic = () => {
        const taken = lastDiagnostic;
        lastDiagnostic = null;
        return taken;
      };
      let report: Awaited<ReturnType<typeof evaluateHybridModelSnapshot>> | null = null;
      try {
        report = await evaluateHybridModelSnapshot({ model, provider, fixtures, phase: "DIAGNOSTIC", limits: { maxCalls: 1, maxCredits: maxUsd, allowRepair: false }, takeDiagnostic });
      } finally {
        const transmissions = tracer.transmissions();
        const sweep = candidate === undefined ? null : sweepShellCandidate(fixture, candidate);
        const verdict = report ? hybridLiveRunVerdict(report, { phase: "DIAGNOSTIC", fixtureIds: [EN_ORDINARY], maxCalls: 1 }, { maxCredits: maxUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot }, null) : null;
        await tracer.record("02-analysis.json", { kind: "ANALYSIS", transmissions, sweep, report, verdict });
        const redaction = await verifyTraceRedaction(tracer.files(), token.token);
        console.log(JSON.stringify({ packet11HybridDiagnostic: { transmissions, traceFailure: tracer.failure(), presendChecks: tracer.checks().map((check) => ({ passed: check.passed, violations: check.violations })), diagnostic: report?.fixtures[0]?.diagnostic ?? null, sweep, report, verdict, redaction, trace: { directory: relative(process.cwd(), resolve(tracer.directory)), files: tracer.files() } } }));
        expect(transmissions.length).toBeLessThanOrEqual(1);
        expect(tracer.failure()).toBeNull();
        expect(redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      }
      expect(report!.totals.calls).toBeLessThanOrEqual(1);
      expect(report!.totals.credits).toBeLessThanOrEqual(maxUsd);
    },
    5 * 60_000,
  );
});
