// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { PACKET_11_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { shellCallUpperBound } from "@/application/ai/ai-shell-route-contract";
import { createDeepSeekResponsesProvider, createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { requestFixture } from "@/domain/ai/ai-test-fixtures";
import { aiInvocationAuditRowSchema, SHELL_MAX_OUTPUT_TOKENS, SHELL_TEMPERATURE, SHELL_INPUT_VERSIONS, SHELL_OUTPUT_VERSIONS, type AiInvocationAuditRow, type ShellTask } from "@/domain/ai";
import { DEEPSEEK_RESPONSES_PROFILE } from "@/ai/deepseek/deepseek-responses-provider";
import { KIE_DIAGNOSTIC_CODES, KIE_RESPONSES_PROFILE, createKieResponsesProvider, createKieShellResponsesProvider, createShellResponsesProvider, type KieProviderDiagnostic } from "./kie-responses-provider";
import { KIE_RESPONSES_URL } from "./kie-model-catalogue";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectEvaluationCandidates } from "./kie-route-config";
import { shellOutputJsonSchema } from "./kie-shell-contracts";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";

const TOKEN = "deepseek-SENTINEL-credential-shell";
const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => "2026-10-06T01:00:00.000Z" });
const MODEL = (selection.kind === "SELECTED" ? selection.candidates[0] : null)!;
const documented = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "24778070-1c36-4ae0-a4bd-870afc7fc13e", object: "response", created_at: 1753000000, status: "completed", model: "deepseek-flash",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 600, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 680 },
  store: false, parallel_tool_calls: true, previous_response_id: null, error: null, incomplete_details: null, ...extra,
});
const reply = (body: unknown) => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const shellRequest = () => projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan);
// Observation ownership (@11b.8): the model's EXPLAIN shells are the headline and the evidence.
const VALID = JSON.stringify({ schemaVersion: "ai-shell.explain-pattern@11b.8", slotPlanVersion: "ai-slot-plan.11b.9", tokenInventory: ["S1", "S3"], taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcome: "SUCCESS", abstentionReason: null, shells: { headline: "A look at {{S1}}.", evidence: "This is based on {{S3}}." } });

describe("shell Responses provider (evaluation-only)", () => {
  it("sends the 11b.13 shell prompt as instructions and the value-blind request as the only input message", async () => {
    const fetcher = reply(documented(VALID));
    const provider = createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher });
    const result = await provider.invoke(shellRequest(), new AbortController().signal);
    expect(fetcher.mock.calls[0]![0]).toBe(DEEPSEEK_RESPONSES_URL);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    // 11b.9: the shell body carries the fixed output cap as its last key; r7 (ai-shell-request.11b.11) adds the fixed
    // temperature 0.2 just before it; nothing else moved.
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text", "temperature", "max_output_tokens"]);
    expect(body).toMatchObject({ model: "deepseek-flash", stream: false, store: false, instructions: shellPromptFor("EXPLAIN_PATTERN", "en-SG")!.text, reasoning: { effort: "none" }, temperature: 0.2, max_output_tokens: 512 });
    expect(body.input).toHaveLength(1);
    expect(JSON.parse(body.input[0].content[0].text)).toEqual(shellRequest());
    expect(body.text.format).toEqual({ type: "json_schema", name: "explain_pattern_shell_en_sg", schema: shellOutputJsonSchema("EXPLAIN_PATTERN", "en-SG"), strict: true });
    expect(JSON.stringify(body)).not.toMatch(/6\.2|7\.1|fact-|claim-|MMOL_L/);
    expect(result).toMatchObject({ kind: "COMPLETED", responseModel: "deepseek-flash", retention: "CONFIRMED_NOT_STORED" });
  });
  it("refuses an unapproved shell request before any fetch", async () => {
    const fetcher = reply(documented(VALID));
    const tampered = structuredClone(shellRequest()) as any;
    tampered.slots[1].gloss = "the value 6.2 mmol/L";
    expect(await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(tampered, new AbortController().signal)).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends the validated clone, never a toJSON or getter the caller controls", async () => {
    const approved = shellRequest() as any;
    const hostile = { ...approved, slots: [{ ...approved.slots[0], gloss: "6.2 mmol/L" }, ...approved.slots.slice(1)] };
    // A class method is non-enumerable, so this passes the strict schema while its toJSON would emit the value.
    class Hostile {
      constructor() {
        Object.assign(this, approved);
      }
      toJSON() {
        return hostile;
      }
    }
    const viaToJson = new Hostile();
    expect(JSON.stringify(viaToJson)).toContain("6.2");
    let reads = 0;
    const viaGetter = { ...approved };
    Object.defineProperty(viaGetter, "slots", { enumerable: true, get: () => (reads++ === 0 ? approved.slots : hostile.slots) });

    const fetcher = reply(documented(VALID));
    await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(viaToJson as never, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = String(fetcher.mock.calls[0]![1].body);
    expect(sent).not.toContain("6.2");
    expect(JSON.parse(JSON.parse(sent).input[0].content[0].text)).toEqual(approved);
    expect(sent).toContain(JSON.stringify(approved.slots[0].gloss).slice(1, -1));

    // A getter that turns hostile after the first read is either rejected before any fetch or sent from the clone.
    const getterFetcher = reply(documented(VALID));
    const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: getterFetcher }).invoke(viaGetter as never, new AbortController().signal);
    if (getterFetcher.mock.calls.length === 0) expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    else expect(String(getterFetcher.mock.calls[0]![1].body)).not.toContain("6.2");
  });
  it("keeps a malformed candidate as the raw string (no trimming)", async () => {
    const raw = `${VALID}}`;
    const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(documented(raw)) }).invoke(shellRequest(), new AbortController().signal);
    expect(result).toMatchObject({ kind: "COMPLETED", candidate: raw });
  });
  it("applies the identical identity and retention rules", async () => {
    // Packet 11C Addendum C (C5): the refused, billed response keeps its reported usage (see "usage on failed shell calls" below).
    expect(await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(documented(VALID, { model: "deepseek-pro" })) }).invoke(shellRequest(), new AbortController().signal)).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { inputTokens: 600, outputTokens: 80, basis: "REPORTED" } });
    const unstored = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(documented(VALID, { store: undefined })) }).invoke(shellRequest(), new AbortController().signal);
    expect(unstored).toMatchObject({ kind: "COMPLETED", retention: "RETENTION_UNCONFIRMED" });
  });
  it("never puts the credential anywhere except the Authorization header", async () => {
    const fetcher = reply(documented(VALID));
    await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(shellRequest(), new AbortController().signal);
    const init = fetcher.mock.calls[0]![1];
    expect(String(init.body)).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * Packet 11B.9/11B.10: the per-task hybrid shell output caps (owner instruction 2026-10-06: EXPLAIN 512, care 1024) and
 * truncation as a shell failure.
 */
describe("per-task hybrid shell output caps ai-shell-request.11b.10 (EXPLAIN 512, care 1024)", () => {
  const SMOKE_IDS = ["p11.explain-pattern.en-sg.ordinary", "p11.explain-pattern.zh-sg.ordinary", "p11.draft-care-preparation-summary.en-sg.ordinary", "p11.draft-care-preparation-summary.zh-sg.ordinary"] as const;
  const EXPLAIN_ID = "p11.explain-pattern.en-sg.ordinary";
  const CARE_ID = "p11.draft-care-preparation-summary.en-sg.ordinary";
  const CAP: Readonly<Record<ShellTask, number>> = { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 };
  const grokSelection = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now: () => "2026-10-06T01:00:00.000Z" });
  const GROK = (grokSelection.kind === "SELECTED" ? grokSelection.candidates[0] : null)!;
  const grokReply = (text: string, extra: Record<string, unknown> = {}) => reply({ status: "completed", model: "grok-4-7", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 600, output_tokens: 80 }, credits_consumed: 0.1, ...extra });
  const sent = (fetcher: ReturnType<typeof reply>) => JSON.parse(String(fetcher.mock.calls[0]![1].body)) as Record<string, unknown>;
  const requestOf = (id: string) => projectShellTaskRequest(plannedFixture(id).plan);
  const usage = (output: number) => ({ usage: { input_tokens: 600, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 } } });
  /** Packet 11C Addendum C (C5): the reported usage a refused, billed shell response now carries on its FAILED result. */
  const BILLED = (output: number) => ({ inputTokens: 600, outputTokens: output, costMicroUsd: deepSeekCostMicroUsd(600, output), credits: null, basis: "REPORTED" });
  async function shellCall(body: unknown, request: ReturnType<typeof requestOf> = shellRequest()) {
    let diagnostic: KieProviderDiagnostic | null = null;
    const fetcher = reply(body);
    const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher, onDiagnostic: (value) => (diagnostic = value) }).invoke(request, new AbortController().signal);
    return { result, diagnostic: diagnostic as KieProviderDiagnostic | null, fetcher };
  }

  it("the single source of truth is the frozen per-task literal map in the domain", () => {
    expect(SHELL_MAX_OUTPUT_TOKENS).toEqual(CAP);
    expect(Object.isFrozen(SHELL_MAX_OUTPUT_TOKENS)).toBe(true);
  });
  it("EXPLAIN always sends 512 and care always sends 1024, in both layouts and both locales (DeepSeek and Kie shell providers)", async () => {
    expect(GROK.endpoint).not.toBe(DEEPSEEK_RESPONSES_URL);
    for (const id of SMOKE_IDS) {
      const request = requestOf(id);
      const cap = CAP[request.taskType];
      const instructions = reply(documented(VALID));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: instructions }).invoke(request, new AbortController().signal);
      expect(sent(instructions), `${id} INSTRUCTIONS_FIELD`).toMatchObject({ max_output_tokens: cap, instructions: expect.any(String) });
      expect(Object.keys(sent(instructions)).at(-1), id).toBe("max_output_tokens");
      const separate = grokReply(VALID);
      await createKieShellResponsesProvider({ token: TOKEN, model: GROK, fetcher: separate }).invoke(request, new AbortController().signal);
      expect(separate).toHaveBeenCalledTimes(1);
      const body = sent(separate);
      expect(body, `${id} SEPARATE_USER_MESSAGES`).not.toHaveProperty("instructions");
      expect(body.input as unknown[], id).toHaveLength(2);
      expect(Object.keys(body).at(-1), id).toBe("max_output_tokens");
      expect(body.max_output_tokens, id).toBe(cap);
    }
    expect(CAP.EXPLAIN_PATTERN).toBe(512);
    expect(CAP.DRAFT_CARE_PREPARATION_SUMMARY).toBe(1024);
  });
  it("no configuration cast (scalar, per-task map or body), profile or model field can change either cap", async () => {
    const casts = [
      { maxOutputTokens: 4096 }, { max_output_tokens: 4096 }, { max_output_tokens: null }, { body: { max_output_tokens: 4096 } },
      { maxOutputTokens: undefined, max_output_tokens: undefined },
      { maxOutputTokens: { EXPLAIN_PATTERN: 1024, DRAFT_CARE_PREPARATION_SUMMARY: 512 } },
      { shellMaxOutputTokens: { EXPLAIN_PATTERN: 1024, DRAFT_CARE_PREPARATION_SUMMARY: 512 } },
      { max_output_tokens: { EXPLAIN_PATTERN: 2048, DRAFT_CARE_PREPARATION_SUMMARY: 2048 } },
    ];
    for (const id of [EXPLAIN_ID, CARE_ID]) {
      const request = requestOf(id);
      for (const extra of casts) {
        const fetcher = reply(documented(VALID));
        await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher, ...extra } as never).invoke(request, new AbortController().signal);
        expect(sent(fetcher).max_output_tokens, `${id} ${JSON.stringify(extra)}`).toBe(CAP[request.taskType]);
      }
      // A model snapshot carrying cap fields.
      const viaModel = reply(documented(VALID));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: { ...MODEL, maxOutputTokens: 4096, max_output_tokens: 4096, shellMaxOutputTokens: { EXPLAIN_PATTERN: 1024, DRAFT_CARE_PREPARATION_SUMMARY: 512 } } as never, fetcher: viaModel }).invoke(request, new AbortController().signal);
      expect(sent(viaModel).max_output_tokens, id).toBe(CAP[request.taskType]);
      // A provider profile carrying cap fields.
      const viaProfile = reply(documented(VALID));
      const profile = { ...DEEPSEEK_RESPONSES_PROFILE, maxOutputTokens: 4096, max_output_tokens: 4096, outputCap: 4096, shellMaxOutputTokens: { EXPLAIN_PATTERN: 1024, DRAFT_CARE_PREPARATION_SUMMARY: 512 } } as never;
      await createShellResponsesProvider(profile, { token: TOKEN, model: MODEL, fetcher: viaProfile }).invoke(request, new AbortController().signal);
      expect(sent(viaProfile).max_output_tokens, id).toBe(CAP[request.taskType]);
    }
  });
  it("the builder takes the cap from the domain map by the schema-parsed task only, never from a bundle, config or profile", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/kie/kie-responses-provider.ts"), "utf8");
    expect(source).not.toMatch(/ai-hybrid-runtime-bundles|\.shellMaxOutputTokens|process\.env/);
    expect(source.match(/outputCap: \(task\) => shellMaxOutputTokens\(task\),/g)).toHaveLength(1);
    expect(source.match(/outputCap: \(\) => null,/g)).toHaveLength(1);
    expect(source).toMatch(/const cap = contract\.outputCap\(parsed\.task\);/);
    expect(source).toMatch(/max_output_tokens: cap/);
    expect(source).not.toMatch(/config\.[A-Za-z_]*(?:max|Max)[A-Za-z_]*(?:Output|output|Tokens|tokens)/);
    expect(source).not.toMatch(/profile\.[A-Za-z_]*(?:max|Max|cap|Cap)/);
  });
  it("a shell input with an extra key (an output cap or anything else) is rejected before transmission, for both tasks", async () => {
    for (const id of [EXPLAIN_ID, CARE_ID]) {
      for (const extra of [{ max_output_tokens: 4096 }, { maxOutputTokens: 4096 }, { body: {} }, { shellMaxOutputTokens: 1024 }]) {
        const fetcher = reply(documented(VALID));
        const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke({ ...requestOf(id), ...extra }, new AbortController().signal);
        expect(result, `${id} ${JSON.stringify(extra)}`).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
        expect(fetcher).not.toHaveBeenCalled();
      }
    }
  });
  it("a request relabelled to the other task cannot obtain the other task's cap: it fails schema or approval, unsent", async () => {
    const explain = requestOf(EXPLAIN_ID);
    const care = requestOf(CARE_ID);
    const relabelled = [
      // The task label alone.
      { ...explain, taskType: "DRAFT_CARE_PREPARATION_SUMMARY" },
      { ...care, taskType: "EXPLAIN_PATTERN" },
      // The label with every per-task version and the bundle key moved too.
      { ...explain, taskType: "DRAFT_CARE_PREPARATION_SUMMARY", shellInputVersion: SHELL_INPUT_VERSIONS.DRAFT_CARE_PREPARATION_SUMMARY, shellSchemaVersion: SHELL_OUTPUT_VERSIONS.DRAFT_CARE_PREPARATION_SUMMARY, runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey },
      { ...care, taskType: "EXPLAIN_PATTERN", shellInputVersion: SHELL_INPUT_VERSIONS.EXPLAIN_PATTERN, shellSchemaVersion: SHELL_OUTPUT_VERSIONS.EXPLAIN_PATTERN, runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey },
      { ...care, taskType: "EXPLAIN_PATTERN", shellInputVersion: SHELL_INPUT_VERSIONS.EXPLAIN_PATTERN, shellSchemaVersion: SHELL_OUTPUT_VERSIONS.EXPLAIN_PATTERN, runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey, claimFamily: "COMPARABLE_SLOT_TREND" },
    ];
    for (const request of relabelled) {
      const fetcher = reply(documented(VALID));
      const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(request as never, new AbortController().signal);
      expect(result, request.taskType).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("the legacy full-prose body is unchanged: no max_output_tokens, same key order", async () => {
    const projected = projectProviderTaskPayload(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    const fetcher = reply(documented("{}"));
    await createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(projected.payload, new AbortController().signal);
    expect(Object.keys(sent(fetcher))).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text"]);
    expect(sent(fetcher)).not.toHaveProperty("max_output_tokens");
  });

  it("names OUTPUT_TRUNCATED as a closed diagnostic code", () => {
    expect(KIE_DIAGNOSTIC_CODES).toContain("OUTPUT_TRUNCATED");
    expect(Object.isFrozen(KIE_DIAGNOSTIC_CODES)).toBe(true);
  });
  it.each([
    ["status incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["status incomplete without details", { status: "incomplete" }],
    ["incomplete_details present on a completed status", { incomplete_details: { reason: "max_output_tokens" } }],
    ["incomplete_details present but empty", { incomplete_details: {} }],
  ])("%s is a FAILED shell call (OUTPUT_TRUNCATED) for both tasks, with its billed usage kept", async (_label, extra) => {
    for (const id of [EXPLAIN_ID, CARE_ID]) {
      const { result, diagnostic } = await shellCall(documented(VALID, extra), requestOf(id));
      // Packet 11C Addendum C (C5): the billed usage is now also on the result (it was only in the diagnostic before).
      expect(result, id).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: BILLED(80) });
      expect(diagnostic, id).toMatchObject({ code: "OUTPUT_TRUNCATED", parserStage: "STATUS", documentedSchemaParsed: true, retention: "CONFIRMED_NOT_STORED" });
      expect(diagnostic!.mismatchUsage, id).toEqual(diagnostic!.reportedUsage);
      expect(diagnostic!.mismatchUsage, id).toMatchObject({ inputTokens: 600, outputTokens: 80 });
    }
  });
  it.each([
    [EXPLAIN_ID, 511, "COMPLETED"], [EXPLAIN_ID, 512, "OUTPUT_TRUNCATED"], [EXPLAIN_ID, 513, "OUTPUT_TRUNCATED"], [EXPLAIN_ID, 600, "OUTPUT_TRUNCATED"], [EXPLAIN_ID, 1023, "OUTPUT_TRUNCATED"],
    [CARE_ID, 511, "COMPLETED"], [CARE_ID, 512, "COMPLETED"], [CARE_ID, 600, "COMPLETED"], [CARE_ID, 1023, "COMPLETED"], [CARE_ID, 1024, "OUTPUT_TRUNCATED"], [CARE_ID, 1025, "OUTPUT_TRUNCATED"],
    ["p11.draft-care-preparation-summary.zh-sg.ordinary", 1023, "COMPLETED"], ["p11.draft-care-preparation-summary.zh-sg.ordinary", 1024, "OUTPUT_TRUNCATED"], ["p11.explain-pattern.zh-sg.ordinary", 512, "OUTPUT_TRUNCATED"],
  ] as const)("%s with %i output tokens is %s (threshold = that task's cap)", async (id, output, code) => {
    const { result, diagnostic } = await shellCall(documented(VALID, { ...usage(output), incomplete_details: null }), requestOf(id));
    if (code === "COMPLETED") {
      expect(result).toMatchObject({ kind: "COMPLETED", usage: { outputTokens: output } });
      expect(diagnostic).toMatchObject({ code: "COMPLETED", mismatchUsage: null });
    } else {
      expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: BILLED(output) });
      expect(diagnostic).toMatchObject({ code: "OUTPUT_TRUNCATED", parserStage: "STATUS", mismatchUsage: { inputTokens: 600, outputTokens: output } });
    }
  });
  it("a truncated response from the wrong model still records its model identity as evidence (outcome unchanged)", async () => {
    const { result, diagnostic } = await shellCall(documented(VALID, { status: "incomplete", model: "deepseek-pro" }));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: BILLED(80) });
    expect(diagnostic).toMatchObject({ code: "OUTPUT_TRUNCATED", modelIdentity: { requested: "deepseek-flash", expected: "deepseek-flash", returned: "deepseek-pro", comparison: "OTHER_SAFE_IDENTIFIER" } });
  });
  it("a truncated response the provider reports as stored is still RESPONSE_STORED, for both tasks", async () => {
    for (const id of [EXPLAIN_ID, CARE_ID]) {
      for (const extra of [{ status: "incomplete" }, { incomplete_details: { reason: "max_output_tokens" } }, usage(CAP[requestOf(id).taskType])]) {
        const { result, diagnostic } = await shellCall(documented(VALID, { ...extra, store: true }), requestOf(id));
        expect(result, `${id} ${JSON.stringify(extra)}`).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { inputTokens: 600, basis: "REPORTED" } });
        expect(diagnostic, `${id} ${JSON.stringify(extra)}`).toMatchObject({ code: "RESPONSE_STORED", parserStage: "RETENTION", retention: "PROVIDER_REPORTED_STORED", mismatchUsage: { inputTokens: 600 } });
      }
    }
  });
  it("legacy: an incomplete legacy response keeps STATUS_NOT_COMPLETED, and a long completed one is not truncated", async () => {
    const projected = projectProviderTaskPayload(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    let diagnostic: KieProviderDiagnostic | null = null;
    const legacy = (body: unknown) => createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(body), onDiagnostic: (value) => (diagnostic = value) }).invoke(projected.payload, new AbortController().signal);
    expect(await legacy(documented("{}", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "STATUS_NOT_COMPLETED", parserStage: "STATUS", mismatchUsage: null, modelIdentity: null });
    expect(await legacy(documented("{}", { usage: { input_tokens: 600, output_tokens: 2048 }, incomplete_details: null }))).toMatchObject({ kind: "COMPLETED" });
    expect(diagnostic).toMatchObject({ code: "COMPLETED" });
  });
  it.each([
    [EXPLAIN_ID, "EXPLAIN_PATTERN", 512],
    [CARE_ID, "DRAFT_CARE_PREPARATION_SUMMARY", 1024],
  ] as const)("service level (%s): a truncated shell response falls back to the deterministic composition after exactly one call, never repaired", async (id, task, cap) => {
    const fixture = plannedFixture(id);
    const fetcher = reply(documented(VALID, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 600, output_tokens: cap } }));
    const rows: AiInvocationAuditRow[] = [];
    const manifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, [task]: "SYNTHETIC_REMOTE_ENABLED" } } as typeof AI_ACTIVATION_MANIFEST;
    // Packet 11C Addendum C (C1): test-only QUALIFIED records (independent of the shipped records).
    const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", manifest, provider: createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }), audit: { append: async (row) => void rows.push(row) }, now: () => "2026-10-06T01:00:00.000Z", monotonicMs: () => 0, requestClassGate: qualifiedTestRequestClassGate() });
    const result = await service.execute(fixture.request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_FAILED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sent(fetcher).max_output_tokens).toBe(cap);
    expect(rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(rows[0]).success).toBe(true);
    expect(rows[0]).toMatchObject({ outcomeCode: "PROVIDER_FAILED", runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES[task].bundleKey, attempts: { count: 1, structuralRepairUsed: false } });
    // The current bundle set (11b.20 offline candidate: prompt 11b.20, rules r12); the request profile is ai-shell-request.11b.11
    // (caps unchanged, temperature 0.2).
    expect(AI_HYBRID_RUNTIME_BUNDLES[task].bundleKey).toMatch(/@11b\.20$/);
  });
});

/**
 * Rules r7 (owner instruction 2026-10-06, offline only): the hybrid shell request (ai-shell-request.11b.11) samples at the frozen
 * domain temperature SHELL_TEMPERATURE = 0.2, in both layouts and for both shell providers. Nothing the caller controls can change
 * or remove it, and the legacy full-prose request bytes are byte-identical (no temperature key).
 */
describe("hybrid shell sampling temperature 0.2 (ai-shell-request.11b.11, r7)", () => {
  const ALL_IDS = ["p11.explain-pattern.en-sg.ordinary", "p11.explain-pattern.zh-sg.ordinary", "p11.draft-care-preparation-summary.en-sg.ordinary", "p11.draft-care-preparation-summary.zh-sg.ordinary"] as const;
  const now = () => "2026-10-06T01:00:00.000Z";
  const grokSelection = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now });
  const GROK = (grokSelection.kind === "SELECTED" ? grokSelection.candidates[0] : null)!;
  /** The Kie DeepSeek snapshot (INSTRUCTIONS_FIELD layout on the Kie endpoint). */
  const KIE_FLASH = { requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "deepseek-v4-1-flash-260910", provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY", endpoint: KIE_RESPONSES_URL, contextWindow: null, defaultReasoningLevel: null, supportedReasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], retrievedAt: "2026-10-05T01:00:00.000Z", documentationUrl: "https://docs.kie.ai/market/deepseek-v4-1-flash.md" } as never;
  const sent = (fetcher: ReturnType<typeof reply>) => JSON.parse(String(fetcher.mock.calls[0]![1].body)) as Record<string, unknown>;
  const requestOf = (id: string) => projectShellTaskRequest(plannedFixture(id).plan);
  const kieReply = (model: string) => reply({ status: "completed", model, store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: VALID }] }], usage: { input_tokens: 600, output_tokens: 80 }, credits_consumed: 0.1 });

  it("the single source of truth is the domain literal 0.2", () => {
    expect(SHELL_TEMPERATURE).toBe(0.2);
  });
  it("every task x locale x layout carries temperature exactly 0.2 (DeepSeek, Kie DeepSeek and Kie Grok shell providers); the cap stays the last key", async () => {
    expect(GROK.endpoint).not.toBe(DEEPSEEK_RESPONSES_URL);
    for (const id of ALL_IDS) {
      const request = requestOf(id);
      const bodies: Array<readonly [string, Record<string, unknown>]> = [];
      const deepseek = reply(documented(VALID));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher: deepseek }).invoke(request, new AbortController().signal);
      bodies.push(["deepseek INSTRUCTIONS_FIELD", sent(deepseek)]);
      const kieFlash = kieReply("deepseek-v4-1-flash-260910");
      await createKieShellResponsesProvider({ token: TOKEN, model: KIE_FLASH, fetcher: kieFlash }).invoke(request, new AbortController().signal);
      bodies.push(["kie INSTRUCTIONS_FIELD", sent(kieFlash)]);
      const grok = kieReply("grok-4-7");
      await createKieShellResponsesProvider({ token: TOKEN, model: GROK, fetcher: grok }).invoke(request, new AbortController().signal);
      bodies.push(["kie SEPARATE_USER_MESSAGES", sent(grok)]);
      for (const [label, body] of bodies) {
        expect(body.temperature, `${id} ${label}`).toBe(0.2);
        expect(Object.keys(body).slice(-2), `${id} ${label}`).toEqual(["temperature", "max_output_tokens"]);
        expect(body, `${id} ${label}`).not.toHaveProperty("top_p");
      }
      expect(bodies[0]![1], id).toHaveProperty("instructions");
      expect(bodies[1]![1], id).toHaveProperty("instructions");
      expect(bodies[2]![1], id).not.toHaveProperty("instructions");
    }
  });
  it("every one of the 70 hybrid fixtures' shell body carries temperature 0.2", async () => {
    let checked = 0;
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const planned = plannedFixture(fixture.id);
      if (planned.plan.remote.eligible !== true) continue;
      const fetcher = reply(documented(VALID));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
      expect(sent(fetcher).temperature, fixture.id).toBe(0.2);
      checked += 1;
    }
    expect(checked).toBe(70);
  });
  it("no configuration cast (temperature, top_p, body, sampling), profile or model field can change or remove it", async () => {
    const casts = [
      { temperature: 1 }, { temperature: 1.0 }, { temperature: 0 }, { temperature: null }, { temperature: undefined }, { temperature: "0.2" },
      { top_p: 0.1 }, { topP: 0.1 }, { body: { temperature: 1, top_p: 0.1 } }, { sampling: { temperature: 1, top_p: 0.1 } }, { shellTemperature: 1 },
    ];
    for (const id of ALL_IDS) {
      const request = requestOf(id);
      for (const extra of casts) {
        const fetcher = reply(documented(VALID));
        await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher, ...extra } as never).invoke(request, new AbortController().signal);
        expect(sent(fetcher).temperature, `${id} ${JSON.stringify(extra)}`).toBe(0.2);
        expect(sent(fetcher), `${id} ${JSON.stringify(extra)}`).not.toHaveProperty("top_p");
      }
      const viaModel = reply(documented(VALID));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: { ...MODEL, temperature: 1, top_p: 0.1, sampling: { temperature: 1 }, defaultTemperature: 1 } as never, fetcher: viaModel }).invoke(request, new AbortController().signal);
      expect(sent(viaModel).temperature, id).toBe(0.2);
      expect(sent(viaModel), id).not.toHaveProperty("top_p");
      const viaProfile = reply(documented(VALID));
      const profile = { ...DEEPSEEK_RESPONSES_PROFILE, temperature: 1, top_p: 0.1, sampling: { temperature: 1 }, body: { temperature: 1 } } as never;
      await createShellResponsesProvider(profile, { token: TOKEN, model: MODEL, fetcher: viaProfile }).invoke(request, new AbortController().signal);
      expect(sent(viaProfile).temperature, id).toBe(0.2);
      const viaKieProfile = kieReply("grok-4-7");
      await createShellResponsesProvider({ ...KIE_RESPONSES_PROFILE, temperature: 1 } as never, { token: TOKEN, model: GROK, fetcher: viaKieProfile, temperature: 1 } as never).invoke(request, new AbortController().signal);
      expect(sent(viaKieProfile).temperature, id).toBe(0.2);
    }
  });
  it("a shell input carrying temperature, top_p or sampling keys is rejected before transmission", async () => {
    for (const id of ALL_IDS) {
      for (const extra of [{ temperature: 1 }, { temperature: 0.2 }, { top_p: 0.1 }, { sampling: { temperature: 1 } }, { body: { temperature: 1 } }]) {
        const fetcher = reply(documented(VALID));
        const result = await createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke({ ...requestOf(id), ...extra }, new AbortController().signal);
        expect(result, `${id} ${JSON.stringify(extra)}`).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
        expect(fetcher).not.toHaveBeenCalled();
      }
    }
  });
  it("the builder takes the temperature from the frozen contract and the domain constant only", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/kie/kie-responses-provider.ts"), "utf8");
    expect(source.match(/temperature: \(\) => SHELL_TEMPERATURE,/g)).toHaveLength(1);
    expect(source.match(/temperature: \(\) => null,/g)).toHaveLength(1);
    expect(source).not.toMatch(/(?:config|profile|parsed|input)\.[A-Za-z_]*(?:temperature|Temperature|top_p|topP|sampling)/);
    expect(source).not.toMatch(/top_p/);
  });
  it("the legacy full-prose bodies are byte-identical to ai-shell-request.11b.10-era bytes: no temperature, no top_p (DeepSeek, Kie DeepSeek, Kie Grok)", async () => {
    const models = [["deepseek", MODEL], ["kie-flash", KIE_FLASH], ["kie-grok", GROK]] as const;
    const bodies: string[] = [];
    for (const [name, model] of models) {
      for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
        const projected = projectProviderTaskPayload(requestFixture(task), AI_TASK_RUNTIME_BUNDLES[task]);
        if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
        const fetcher = reply(documented("{}"));
        const provider = name === "deepseek" ? createDeepSeekResponsesProvider({ token: TOKEN, model, fetcher }) : createKieResponsesProvider({ token: TOKEN, model, fetcher });
        await provider.invoke(projected.payload, new AbortController().signal);
        const text = String(fetcher.mock.calls[0]![1].body);
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(body, `${name} ${task}`).not.toHaveProperty("temperature");
        expect(body, `${name} ${task}`).not.toHaveProperty("top_p");
        expect(body, `${name} ${task}`).not.toHaveProperty("max_output_tokens");
        bodies.push(text);
      }
    }
    // Digest of the six legacy bodies captured before r7 (pre-change baseline, same fixtures and models).
    expect(createHash("sha256").update(bodies.join("\n")).digest("hex")).toBe("d13dff45b60e5347ccde8861abd5e61366251f31a4c5b2fb501f53ea73c5e8b4");
  });
});

/**
 * Packet 11C Addendum C, Task C5 (owner decision: preserve reported usage on failed attempts; account conservatively when an attempted
 * call might have been billed but usage is missing). The slot-shell contract only (the DeepSeek shell provider behind the route and the
 * evaluation runners): every failure after the request was transmitted carries usage, the provider-reported usage when the response
 * reported it, else the call's pre-send upper bound (`shellCallUpperBound` of the exact body). A failure before transmission carries
 * none. The request body is unchanged (the digests above and the freeze test pin it); the legacy full-prose contract is unchanged.
 */
describe("usage on failed shell calls (Packet 11C Addendum C, C5)", () => {
  const REPORTED = { inputTokens: 600, outputTokens: 80, costMicroUsd: deepSeekCostMicroUsd(600, 80), credits: null, basis: "REPORTED" };
  const respond = (status: number, body: string, contentType = "application/json") => vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status, headers: { "content-type": contentType } }));
  const boundOf = (fetcher: ReturnType<typeof vi.fn>, task: ShellTask = "EXPLAIN_PATTERN") => ({ ...shellCallUpperBound(new TextEncoder().encode(String((fetcher.mock.calls[0]![1] as RequestInit).body)).byteLength, task), credits: null });
  const invoke = (fetcher: (url: string, init: RequestInit) => Promise<Response>, request: unknown = shellRequest()) => createDeepSeekShellResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(request as never, new AbortController().signal);
  const grokSelection = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now: () => "2026-10-06T01:00:00.000Z" });
  const KIE_GROK = (grokSelection.kind === "SELECTED" ? grokSelection.candidates[0] : null)!;

  it.each([
    ["from another model", { model: "deepseek-pro" }],
    ["with no model", { model: undefined }],
    ["reported as stored", { store: true }],
    ["truncated (incomplete)", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["at the output cap", { usage: { input_tokens: 600, output_tokens: 512 } }],
    ["not completed", { status: "failed" }],
    ["with no output text", { output: [] }],
  ])("a response %s is FAILED with its reported usage", async (label, extra) => {
    const result = await invoke(reply(documented(VALID, extra)));
    const expected = label === "at the output cap" ? { ...REPORTED, outputTokens: 512, costMicroUsd: deepSeekCostMicroUsd(600, 512) } : REPORTED;
    expect(result, label).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: expected });
  });

  it.each([
    ["HTTP 500", () => respond(500, JSON.stringify({ error: { message: "x" } })), "PROVIDER_FAILED"],
    ["HTTP 429", () => respond(429, JSON.stringify({ error: { message: "x" } })), "PROVIDER_RATE_LIMITED"],
    ["HTTP 400", () => respond(400, JSON.stringify({ error: { message: "x" } })), "PROVIDER_REJECTED"],
    ["HTTP 401", () => respond(401, "{}"), "MISSING_CONFIGURATION"],
    ["a non-JSON body", () => respond(200, "not json", "text/plain"), "PROVIDER_FAILED"],
    ["an empty body", () => respond(200, ""), "PROVIDER_FAILED"],
    ["an error envelope", () => respond(200, JSON.stringify({ error: { code: "x", message: "y" } })), "PROVIDER_FAILED"],
    ["a response without usage", () => respond(200, JSON.stringify({ ...documented(VALID), usage: undefined })), "PROVIDER_FAILED"],
    ["a transport failure", () => vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error("offline"))), "TRANSPORT_FAILED"],
  ])("%s after transmission is FAILED with the call's pre-send upper bound", async (label, make, reason) => {
    const fetcher = make();
    const result = await invoke(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result, label).toMatchObject({ kind: "FAILED", reason });
    expect((result as { usage?: unknown }).usage, label).toEqual(boundOf(fetcher));
  });

  it("the care bound uses the care cap (1024) and the exact care body", async () => {
    const fetcher = respond(500, "{}");
    const result = await invoke(fetcher, projectShellTaskRequest(plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary").plan));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: boundOf(fetcher, "DRAFT_CARE_PREPARATION_SUMMARY") });
    expect((result as { usage: { outputTokens: number } }).usage.outputTokens).toBe(1024);
  });

  it("a failure before transmission carries no usage (nothing billed)", async () => {
    const fetcher = reply(documented(VALID));
    const tampered = structuredClone(shellRequest()) as unknown as { slots: Array<{ gloss: string }> };
    tampered.slots[1]!.gloss = "the value 6.2 mmol/L";
    expect(await invoke(fetcher, tampered)).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a completed response is unchanged (reported usage, no basis field)", async () => {
    expect(await invoke(reply(documented(VALID)))).toEqual({ kind: "COMPLETED", candidate: JSON.parse(VALID), usage: { inputTokens: 600, outputTokens: 80, costMicroUsd: deepSeekCostMicroUsd(600, 80), credits: null }, responseModel: "deepseek-flash", retention: "CONFIRMED_NOT_STORED" });
  });

  it("a provider without a USD price (Kie) keeps its reported usage and credits, and has no pre-send bound", async () => {
    const kieReply = (extra: Record<string, unknown>) => reply({ status: "completed", model: "other", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: VALID }] }], usage: { input_tokens: 600, output_tokens: 80 }, credits_consumed: 0.1, ...extra });
    const kie = createKieShellResponsesProvider({ token: TOKEN, model: KIE_GROK, fetcher: kieReply({}) });
    expect(await kie.invoke(shellRequest(), new AbortController().signal)).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { inputTokens: 600, outputTokens: 80, costMicroUsd: null, credits: 0.1, basis: "REPORTED" } });
    const failing = createKieShellResponsesProvider({ token: TOKEN, model: KIE_GROK, fetcher: respond(500, "{}") });
    expect(await failing.invoke(shellRequest(), new AbortController().signal)).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
  });

  it("the legacy full-prose contract is unchanged: its failures carry no usage", async () => {
    const projected = projectProviderTaskPayload(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    const legacy = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(projected.payload, new AbortController().signal);
    expect(await legacy(reply(documented("{}", { model: "deepseek-pro" })))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(await legacy(respond(500, "{}"))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
  });
});
