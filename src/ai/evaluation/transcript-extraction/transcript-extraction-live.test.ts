// @vitest-environment node
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { transcriptExtractionModel } from "@/ai/transcript-extraction/transcript-extraction-request";
import { TRANSCRIPT_EXTRACTION_FIXTURES, goldenOutput, type ExtractionFixture } from "./transcript-extraction-fixtures";
import { TRANSCRIPT_EXTRACTION_FULL_POLICY } from "./transcript-extraction-harness";
import {
  TRANSCRIPT_EXTRACTION_LIVE_ENV,
  TRANSCRIPT_EXTRACTION_LIVE_PRICING,
  createExtractionTracer,
  liveContractMismatches,
  liveGateRefusals as runnerGateRefusals,
  livePreflight,
  liveRunPlan,
  runLiveTranscriptExtraction,
  transcriptExtractionLiveContract,
  verifyTraceHashes,
  verifyTraceRedaction,
  type ExtractionTracer,
} from "./transcript-extraction-live-runner";

/**
 * Packet 13 (P13X): the transcript-extraction live runner (Proposal 3). The offline part always runs with fake fetchers only (no network,
 * no key, no spend). The live part is skipped unless RUN_LIVE_TRANSCRIPT_EXTRACTION=1 and is refused before any request unless
 * TRANSCRIPT_EXTRACTION_PROVIDER=deepseek, TRANSCRIPT_EXTRACTION_MODEL=deepseek-flash, TRANSCRIPT_EXTRACTION_CONFIRM_MAX_CALLS equals the
 * computed call count, TRANSCRIPT_EXTRACTION_RAW_TRACE=1, TRANSCRIPT_EXTRACTION_MAX_USD is at least the computed one-call-each minimum,
 * DEEPSEEK_API_KEY is configured, no NEXT_PUBLIC_* credential name exists, the frozen contract below equals the code, the fixtures are
 * exactly the registered set, and every body passes the preflight. The owner's 2026-10-09 message authorizes preparation and offline
 * verification only: "This authorizes no live calls." A live run needs a separate, explicit owner authorization.
 */

/** Proposal 3 frozen inputs (owner: "Freeze and present the exact contract digest, policy, fixture/call counts and recomputed budget"). */
const REQUIRED_CONTRACT = Object.freeze({
  contractVersion: "transcript-extraction.13.1",
  contractDigest: "c42e1ec3f560be914d59d4050228f0f1e192ba0ac54b4cb8a42e8c705bda0d79",
  promptVersion: "transcript-extraction-prompt.13.1",
  promptSha256: "e61156da83487030ce9f5ff6fbf2a078af25041fb5c95f7e1c4b25dd96f0592f",
  requestProfile: "transcript-extraction-request.13.1",
  schemaName: "transcript_extraction_13_1",
  model: "deepseek-flash",
  temperature: 0,
  maxOutputTokens: 1536,
  validatorVersion: "transcript-extraction-validator.13.3",
  lexiconVersion: "transcript-extraction-lexicon.13.3",
  fixtureSet: "transcript-extraction-fixtures.13.5",
  policy: "transcript-extraction-full-policy.13.1",
  runner: "transcript-extraction-live.13.1",
});
const FROZEN = Object.freeze({ fixtures: 46, notSent: 22, withheld: 10, redirected: 12, calls: 24, minimumMicroUsd: 75_754, maxPerCallMicroUsd: 3_167, proposedMaxUsd: "0.08" });

const SENTINEL = "ds-SENTINEL-CREDENTIAL-13x-77c1e0";
/** The environment and the credential are read ONLY here (the runner module is environment-free) and passed in as arguments. */
const liveGateRefusals = (environment: Readonly<Record<string, string | undefined>>, plan: { maxCalls: number; minimumMicroUsd: number }) =>
  runnerGateRefusals(environment, plan, { configured: readDeepSeekToken(environment).kind === "CONFIGURED" });
const NOW = () => "2026-10-09T08:00:00.000Z";
const MODEL = transcriptExtractionModel()!;
const created = new Set<string>();
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});
const track = (tracer: ExtractionTracer) => void created.add(tracer.directory);

type FakeKind = "GOLDEN" | "NO_USAGE" | "INVALID_USAGE" | "MAX_USAGE" | "TRANSPORT_FAILURE" | "STORED" | "OTHER_MODEL" | "TRUNCATED" | "HTTP_500" | "UNSAFE_NEGATION";
const fixtureOfBody = (body: string): ExtractionFixture => {
  const message = JSON.parse((JSON.parse(body) as { input: [{ content: [{ text: string }] }] }).input[0].content[0].text) as { transcript: string; locale: string };
  return TRANSCRIPT_EXTRACTION_FIXTURES.find((fixture) => fixture.transcript === message.transcript && fixture.locale === message.locale)!;
};
function envelope(text: string, overrides: Record<string, unknown> = {}) {
  return { id: "resp_1", object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 900, output_tokens: 150 }, ...overrides };
}
/** A scripted fake DeepSeek: per fixture id a kind (default GOLDEN); counts sends. */
function fakeDeepSeek(plan: Readonly<Record<string, FakeKind>> = {}) {
  const sent: string[] = [];
  const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
    const fixture = fixtureOfBody(String(init.body)) as ExtractionFixture & { expect: "EXTRACT" };
    sent.push(fixture.id);
    const golden = JSON.stringify(goldenOutput(fixture));
    const bytes = new TextEncoder().encode(String(init.body)).byteLength;
    const kind = plan[fixture.id] ?? "GOLDEN";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    switch (kind) {
      case "GOLDEN":
        return json(envelope(golden));
      case "NO_USAGE":
        return json(envelope(golden, { usage: undefined }));
      case "INVALID_USAGE":
        return json(envelope(golden, { usage: { input_tokens: -1, output_tokens: "x" } }));
      case "MAX_USAGE":
        return json(envelope(golden, { usage: { input_tokens: bytes + 256, output_tokens: 1535 } }));
      case "TRANSPORT_FAILURE":
        throw new Error("FAKE_TRANSPORT_FAILURE");
      case "STORED":
        return json(envelope(golden, { store: true }));
      case "OTHER_MODEL":
        return json(envelope(golden, { model: "deepseek-pro" }));
      case "TRUNCATED":
        return json(envelope("{\"facts\":", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 900, output_tokens: 1536 } }));
      case "HTTP_500":
        return json({ error: { message: "upstream" } }, 500);
      case "UNSAFE_NEGATION": {
        const output = goldenOutput(fixture);
        return json(envelope(JSON.stringify({ ...output, facts: output.facts.map((fact) => ({ ...fact, negated: false })) })));
      }
    }
  };
  return { fetcher, sent };
}
const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };

describe("Packet 13 transcript-extraction live runner (offline)", () => {
  it("Proposal 3 frozen inputs: the contract literal equals the code, and the plan, counts and budget are pinned", () => {
    expect(transcriptExtractionLiveContract()).toEqual(REQUIRED_CONTRACT);
    expect(liveContractMismatches(REQUIRED_CONTRACT)).toEqual([]);
    expect(TRANSCRIPT_EXTRACTION_FULL_POLICY).toMatchObject({ status: "DRAFT_NOT_APPROVED", callsPerFixture: 1, retries: 0, repairs: 0 });
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    expect({
      fixtures: TRANSCRIPT_EXTRACTION_FIXTURES.length,
      notSent: plan.notSent.length,
      withheld: TRANSCRIPT_EXTRACTION_FIXTURES.filter((fixture) => fixture.expect === "WITHHELD").length,
      redirected: TRANSCRIPT_EXTRACTION_FIXTURES.filter((fixture) => fixture.expect === "REDIRECT").length,
      calls: plan.maxCalls,
      minimumMicroUsd: plan.minimumMicroUsd,
      maxPerCallMicroUsd: plan.maxPerCallMicroUsd,
      proposedMaxUsd: FROZEN.proposedMaxUsd,
    }).toEqual(FROZEN);
    expect(plan.sent.length + plan.notSent.length).toBe(FROZEN.fixtures);
    // 12 calls per locale.
    for (const locale of ["en", "zh"]) expect(plan.sent.filter((id) => id.startsWith(`${locale}.`)), locale).toHaveLength(12);
    // The proposed ceiling covers the worst case (one call each at its exact body's upper bound) and passes the gate.
    expect(Math.round(Number(FROZEN.proposedMaxUsd) * 1_000_000)).toBeGreaterThanOrEqual(plan.minimumMicroUsd);
    expect(TRANSCRIPT_EXTRACTION_LIVE_PRICING).toEqual({ inputCacheMiss: 0.3, output: 1.2, source: "DeepSeek quick_start/pricing via deepseek-catalogue.ts", retrieved: "2026-10-06" });
  });

  it("preflight: every sendable body is exact and planned; the gate holds back every withheld and redirect fixture", () => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    expect(livePreflight(plan, MODEL).filter((item) => !item.passed)).toEqual([]);
    expect([...plan.notSent].sort()).toEqual(TRANSCRIPT_EXTRACTION_FIXTURES.filter((fixture) => fixture.expect !== "EXTRACT").map((fixture) => fixture.id).sort());
    // A fixture expected WITHHELD that the gate would send fails the preflight (the run is refused before any call).
    const leaky = TRANSCRIPT_EXTRACTION_FIXTURES.map((fixture) => (fixture.id === "en.health-mixed" ? { ...fixture, transcript: "Sugar 15" } : fixture));
    expect(livePreflight(liveRunPlan(leaky, MODEL), MODEL).filter((item) => !item.passed)).toEqual([{ fixtureId: "en.health-mixed", passed: false, violations: ["GATE_WOULD_SEND"] }]);
  });

  it("the live gate refuses before any request unless every condition holds", () => {
    const plan = { maxCalls: FROZEN.calls, minimumMicroUsd: FROZEN.minimumMicroUsd };
    const E = TRANSCRIPT_EXTRACTION_LIVE_ENV;
    const ok = { [E.provider]: "deepseek", [E.model]: "deepseek-flash", [E.confirmMaxCalls]: "24", [E.rawTrace]: "1", [E.maxUsd]: FROZEN.proposedMaxUsd, DEEPSEEK_API_KEY: SENTINEL };
    expect(liveGateRefusals(ok, plan)).toEqual({ refusals: [], maxUsd: 0.08 });
    expect(liveGateRefusals({ ...ok, [E.maxUsd]: "0.075754" }, plan)).toEqual({ refusals: [], maxUsd: 0.075754 });
    expect(liveGateRefusals({ ...ok, [E.maxUsd]: "0.075753" }, plan).refusals).toEqual(["TRANSCRIPT_EXTRACTION_MAX_USD_BELOW_ONE_CALL_EACH_MINIMUM"]);
    for (const value of ["0", "-1", "abc", "", "1e9", "NaN", "Infinity", "0.1234567"]) expect(liveGateRefusals({ ...ok, [E.maxUsd]: value }, plan).refusals, value).toEqual(["TRANSCRIPT_EXTRACTION_MAX_USD"]);
    expect(liveGateRefusals({ ...ok, [E.provider]: "kie" }, plan).refusals).toEqual([E.provider]);
    expect(liveGateRefusals({ ...ok, [E.model]: "deepseek-chat" }, plan).refusals).toEqual([E.model]);
    for (const value of ["26", "22", "38", ""]) expect(liveGateRefusals({ ...ok, [E.confirmMaxCalls]: value }, plan).refusals, value).toEqual([E.confirmMaxCalls]);
    expect(liveGateRefusals({ ...ok, [E.rawTrace]: "0" }, plan).refusals).toEqual([E.rawTrace]);
    expect(liveGateRefusals({ ...ok, DEEPSEEK_API_KEY: " " }, plan).refusals).toEqual(["PROVIDER_CREDENTIAL_NOT_CONFIGURED"]);
    // The runner itself decides only from the flag it is given.
    expect(runnerGateRefusals(ok, plan, { configured: false }).refusals).toEqual(["PROVIDER_CREDENTIAL_NOT_CONFIGURED"]);
    expect(liveGateRefusals({ ...ok, NEXT_PUBLIC_DEEPSEEK_API_KEY: "x" }, plan).refusals).toEqual(["PUBLIC_CREDENTIAL_NAME_PRESENT"]);
    expect(liveGateRefusals({}, plan).refusals).toEqual([E.provider, E.model, E.confirmMaxCalls, E.rawTrace, E.maxUsd, "PROVIDER_CREDENTIAL_NOT_CONFIGURED"]);
  });

  it("a contract or fixture-set mismatch is refused before the tracer exists (no call)", async () => {
    for (const [key, value] of [["contractDigest", "0".repeat(64)], ["fixtureSet", "transcript-extraction-fixtures.13.2"], ["policy", "transcript-extraction-full-policy.13.0"], ["promptVersion", "x"]] as const) {
      const fake = fakeDeepSeek();
      let tracers = 0;
      await expect(runLiveTranscriptExtraction({ fixtures: TRANSCRIPT_EXTRACTION_FIXTURES, model: MODEL, fetcher: fake.fetcher, token: SENTINEL, ceilingMicroUsd: 80_000, required: { ...REQUIRED_CONTRACT, [key]: value }, now: NOW, onTracer: () => void (tracers += 1) }), key).rejects.toThrow(`CONTRACT_MISMATCH:${key}`);
      expect([fake.sent.length, tracers], key).toEqual([0, 0]);
    }
  });

  it("a full fake run: exactly 24 calls, none for a withheld or redirect fixture, exact call map, draft thresholds met, human review pending", async () => {
    const fake = fakeDeepSeek();
    const run = await runLiveTranscriptExtraction({ fixtures: TRANSCRIPT_EXTRACTION_FIXTURES, model: MODEL, fetcher: fake.fetcher, token: SENTINEL, ceilingMicroUsd: 80_000, required: REQUIRED_CONTRACT, now: NOW, onTracer: track });
    const { summary } = run;
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    expect(fake.sent).toEqual(plan.sent);
    expect(summary).toMatchObject({ stoppedReason: null, fixturesScored: 46, transmissions: 24, notSentCalls: 0, callMap: { kind: "MAPPED" } });
    expect(summary.callMap.kind === "MAPPED" && summary.callMap.entries).toEqual(plan.sent.map((id, index) => [index + 1, id]));
    expect(summary.draft).toMatchObject({ fixtures: 46, calls: 24, withheld: 10, acceptanceRate: 1, exactMatchRate: 1, criticalPassRate: 1, redirectCaughtRate: 1, decision: "MEETS_DRAFT_THRESHOLDS" });
    expect(summary.verdict).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING"] });
    expect(summary.spend).toEqual({ ceilingMicroUsd: 80_000, committedMicroUsd: 24 * deepSeekCostMicroUsd(900, 150), inFlightMicroUsd: 0, billedFromUsage: 24, billedFromUpperBound: 0, boundExceeded: 0 });
    expect(summary.responseClasses).toEqual({ OK: 24 });
    expect(summary.redaction).toEqual({ filesChecked: 50, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(summary.hashes).toEqual({ requestsVerified: 24, responsesVerified: 24, mismatches: 0 });
    // The first request record is the exact body, written before the send, with the Authorization value redacted.
    const request = JSON.parse(readFileSync(run.tracer.files()[0]!, "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({ kind: "REQUEST", sequence: 1, fixtureId: "en.unit", url: DEEPSEEK_RESPONSES_URL, headers: { authorization: "Bearer [REDACTED]" } });
    expect((statSync(run.tracer.directory).mode & 0o777)).toBe(0o700);
    expect(run.tracer.directory.startsWith("test-results/transcript-extraction-live/")).toBe(true);
    // The printed summary carries codes, counts, spend and paths only: no transcript and no model text.
    const printed = JSON.stringify(summary);
    for (const fixture of TRANSCRIPT_EXTRACTION_FIXTURES) expect(printed.includes(fixture.transcript), fixture.id).toBe(false);
    expect(printed).not.toContain(SENTINEL);
    // The private review page lists every fixture; accepted outputs only as validated spans.
    const page = readFileSync(resolve(process.cwd(), summary.trace.reviewPage), "utf8");
    expect(page.match(/<tr data-fixture-id=/g)).toHaveLength(46);
    expect(page).toContain('data-fixture-id="en.health-mixed" data-locale="en-SG" data-outcome="WITHHELD"');
    expect(page).toContain('data-fixture-id="zh.amount-reported" data-locale="zh-SG" data-outcome="WITHHELD"');
    expect((statSync(resolve(process.cwd(), summary.trace.reviewPage)).mode & 0o777)).toBe(0o600);
  }, 60_000);

  it("hard pre-send ceiling: with adversarial usage the committed spend never exceeds the ceiling, and the refused call is never sent", async () => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    const upper = (id: string) => plan.upperBoundMicroUsd.get(id)!;
    const kinds: FakeKind[] = ["MAX_USAGE", "NO_USAGE", "INVALID_USAGE", "TRANSPORT_FAILURE", "GOLDEN"];
    const script = Object.fromEntries(plan.sent.map((id, index) => [id, kinds[index % kinds.length]!]));
    for (const ceiling of [upper(plan.sent[0]!), 10_000, 31_337, 60_000]) {
      const fake = fakeDeepSeek(script);
      const tracer = createExtractionTracer({ plan, ceilingMicroUsd: ceiling, fetcher: fake.fetcher, now: NOW });
      track(tracer);
      let refused: string | null = null;
      for (const id of plan.sent) {
        const body = [...plan.bodies.entries()].find(([, fixtureId]) => fixtureId === id)![0];
        try {
          await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
        } catch (error) {
          if ((error as Error).message === "FAKE_TRANSPORT_FAILURE") continue;
          refused = (error as Error).message;
          // Tight: this call's upper bound would have crossed the ceiling.
          expect(tracer.spend().committedMicroUsd + upper(id), String(ceiling)).toBeGreaterThan(ceiling);
          break;
        }
      }
      expect(refused, String(ceiling)).toBe("TRACE_SPEND_CEILING");
      expect(tracer.spend().committedMicroUsd, String(ceiling)).toBeLessThanOrEqual(ceiling);
      expect(tracer.spend().inFlightMicroUsd).toBe(0);
      expect(fake.sent).toHaveLength(tracer.calls().length);
      // Missing, invalid usage and a lost response are billed at the call's upper bound, never zero.
      for (const call of tracer.calls()) expect(call.billedMicroUsd, call.fixtureId).toBe(["NO_USAGE", "INVALID_USAGE", "TRANSPORT_FAILURE"].includes(script[call.fixtureId]!) ? call.upperBoundMicroUsd : call.billedMicroUsd);
      expect(tracer.calls().every((call) => call.billedMicroUsd > 0 && call.billedMicroUsd <= call.upperBoundMicroUsd)).toBe(true);
      // A refusal is sticky.
      await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: [...plan.bodies.keys()].at(-1)! })).rejects.toThrow("TRACE_SPEND_CEILING");
    }
  });

  it("the tracer refuses unsent: an unplanned body (incl. any withheld fixture), a second call for a fixture (no retry), another endpoint, a write failure", async () => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    const body = [...plan.bodies.keys()][0]!;
    const withheld = TRANSCRIPT_EXTRACTION_FIXTURES.find((fixture) => fixture.id === "zh.health-mixed")!;
    const withheldBody = JSON.stringify({ ...JSON.parse(body), input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({ locale: withheld.locale, allowedFactKinds: withheld.allowedFactKinds, transcript: withheld.transcript }) }] }] });
    const cases: [string, (tracer: ExtractionTracer) => Promise<unknown>, string][] = [
      ["withheld fixture body", (tracer) => tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: withheldBody }), "TRACE_UNEXPECTED_BODY"],
      ["changed body", (tracer) => tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: body.replace("\"temperature\":0", "\"temperature\":1") }), "TRACE_UNEXPECTED_BODY"],
      ["other endpoint", (tracer) => tracer.fetcher("https://api.example.invalid/v1/responses", { method: "POST", headers, body }), "TRACE_ENDPOINT"],
      ["second call (no retry)", async (tracer) => {
        await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
        return tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
      }, "TRACE_DUPLICATE_CALL"],
      ["request record not writable", (tracer) => {
        writeFileSync(join(tracer.directory, `001-${plan.sent[0]}.request.json`), "{}\n", { mode: 0o600 });
        return tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
      }, "TRACE_WRITE_FAILED"],
    ];
    for (const [name, act, code] of cases) {
      const fake = fakeDeepSeek();
      const tracer = createExtractionTracer({ plan, ceilingMicroUsd: 80_000, fetcher: fake.fetcher, now: NOW });
      track(tracer);
      await expect(act(tracer), name).rejects.toThrow(code);
      expect([tracer.failure(), fake.sent.length], name).toEqual([code, name === "second call (no retry)" ? 1 : 0]);
    }
    expect(() => createExtractionTracer({ plan, ceilingMicroUsd: 0, fetcher: fakeDeepSeek().fetcher })).toThrow("TRACE_SPEND_CEILING");
  });

  it.each([
    ["STORED", "RESPONSE_STORED"],
    ["OTHER_MODEL", "RESPONSE_MODEL_MISMATCH"],
    ["TRUNCATED", "RESPONSE_TRUNCATED"],
    ["UNSAFE_NEGATION", null],
  ] as const)("a %s response on the 2nd sent fixture stops the run (%s) or is caught by the r-rules", async (kind, stop) => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    // en.negated-meal is the 3rd sent fixture; for the negation case the r-rules reject the unsafe output (never accepted).
    const target = kind === "UNSAFE_NEGATION" ? "en.negated-meal" : plan.sent[1]!;
    const fake = fakeDeepSeek({ [target]: kind });
    const run = await runLiveTranscriptExtraction({ fixtures: TRANSCRIPT_EXTRACTION_FIXTURES, model: MODEL, fetcher: fake.fetcher, token: SENTINEL, ceilingMicroUsd: 80_000, required: REQUIRED_CONTRACT, now: NOW, onTracer: track });
    if (stop) {
      expect(run.summary.stoppedReason).toBe(stop);
      expect(fake.sent).toEqual(plan.sent.slice(0, 2));
      expect(run.summary.verdict.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", `STOPPED:${stop}`, "FIXTURES_NOT_ALL_SCORED", "HUMAN_REVIEW_PENDING"]));
    } else {
      expect(run.summary.stoppedReason).toBeNull();
      expect(run.scores.find((score) => score.id === target)).toMatchObject({ outcome: "REJECTED", mismatches: ["REJECTED:NEGATION_NOT_PRESERVED"] });
      expect(run.summary.verdict.failures).toEqual(expect.arrayContaining(["CRITICAL_CLASS", "HUMAN_REVIEW_PENDING"]));
    }
    expect(run.summary.redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(run.summary.hashes.mismatches).toBe(0);
  }, 60_000);

  it("three consecutive provider failures stop the run; a transport failure is billed at the upper bound", async () => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    const fake = fakeDeepSeek({ [plan.sent[0]!]: "HTTP_500", [plan.sent[1]!]: "TRANSPORT_FAILURE", [plan.sent[2]!]: "HTTP_500" });
    const run = await runLiveTranscriptExtraction({ fixtures: TRANSCRIPT_EXTRACTION_FIXTURES, model: MODEL, fetcher: fake.fetcher, token: SENTINEL, ceilingMicroUsd: 80_000, required: REQUIRED_CONTRACT, now: NOW, onTracer: track });
    expect(run.summary.stoppedReason).toBe("CONSECUTIVE_PROVIDER_FAILURES");
    expect(fake.sent).toEqual(plan.sent.slice(0, 3));
    expect(run.tracer.calls().map((call) => [call.responseClass, call.billedFrom])).toEqual([["HTTP_ERROR", "UPPER_BOUND"], ["TRANSPORT_FAILED", "UPPER_BOUND"], ["HTTP_ERROR", "UPPER_BOUND"]]);
    expect(run.summary.spend.committedMicroUsd).toBe(plan.sent.slice(0, 3).reduce((sum, id) => sum + plan.upperBoundMicroUsd.get(id)!, 0));
  }, 60_000);

  it("the redaction check detects a planted credential and an unredacted Authorization header", () => {
    const plan = liveRunPlan(TRANSCRIPT_EXTRACTION_FIXTURES, MODEL);
    const tracer = createExtractionTracer({ plan, ceilingMicroUsd: 80_000, fetcher: fakeDeepSeek().fetcher, now: NOW });
    track(tracer);
    tracer.record("001-x.request.json", { kind: "REQUEST", headers: { authorization: `Bearer ${SENTINEL}` }, bodySha256: "0", bodyText: "" });
    expect(readDeepSeekToken({ DEEPSEEK_API_KEY: SENTINEL }).kind).toBe("CONFIGURED");
    expect(verifyTraceRedaction(tracer.directory, tracer.files(), SENTINEL)).toEqual({ filesChecked: 1, secretAbsent: false, authorizationRedacted: false, filesPrivate: true });
    expect(verifyTraceHashes(tracer.files())).toEqual({ requestsVerified: 0, responsesVerified: 0, mismatches: 1 });
  });
});

const env = process.env;
const LIVE = env[TRANSCRIPT_EXTRACTION_LIVE_ENV.run] === "1";

describe.skipIf(!LIVE)("Packet 13 transcript-extraction evaluation (live, at most 24 calls)", () => {
  it(
    "runs the registered fixtures once each against direct DeepSeek under the hard spend ceiling",
    async () => {
      // Every refusal below happens before any request.
      const mismatches = liveContractMismatches(REQUIRED_CONTRACT);
      if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
      const model = transcriptExtractionModel();
      if (!model || model.endpoint !== DEEPSEEK_RESPONSES_URL || model.requestModelId !== "deepseek-flash" || model.responseModelSnapshot !== "deepseek-flash") throw new Error("MODEL_OR_ENDPOINT_NOT_APPROVED");
      const fixtures = TRANSCRIPT_EXTRACTION_FIXTURES;
      if (fixtures.length !== FROZEN.fixtures || new Set(fixtures.map((fixture) => fixture.id)).size !== FROZEN.fixtures) throw new Error("FIXTURE_SELECTION");
      const plan = liveRunPlan(fixtures, model);
      const preflight = livePreflight(plan, model);
      const gate = liveGateRefusals(env, plan);
      console.log(JSON.stringify({ transcriptExtractionLivePlan: { provider: "deepseek", endpoint: model.endpoint, model: model.requestModelId, contract: transcriptExtractionLiveContract(), fixtures: fixtures.length, calls: plan.maxCalls, notSent: plan.notSent.length, minimumUsd: plan.minimumMicroUsd / 1_000_000, maxPerCallUsd: plan.maxPerCallMicroUsd / 1_000_000, maxUsd: gate.maxUsd, pricing: TRANSCRIPT_EXTRACTION_LIVE_PRICING, retries: 0, repairs: 0, preflight: { passed: preflight.filter((item) => item.passed).length, failed: preflight.filter((item) => !item.passed) }, refusals: gate.refusals } }));
      if (plan.maxCalls !== FROZEN.calls || plan.minimumMicroUsd !== FROZEN.minimumMicroUsd) throw new Error("PLAN_NOT_FROZEN");
      if (gate.refusals.length > 0 || gate.maxUsd === null) throw new Error(`LIVE_RUN_REFUSED:${gate.refusals.join(",")}`);
      if (preflight.some((item) => !item.passed)) throw new Error("PREFLIGHT_FAILED");
      const token = readDeepSeekToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("DEEPSEEK_API_KEY is not configured");

      const run = await runLiveTranscriptExtraction({ fixtures, model, fetcher: (url, init) => fetch(url, init), token: token.token, ceilingMicroUsd: Math.round(gate.maxUsd * 1_000_000), required: REQUIRED_CONTRACT });
      console.log(JSON.stringify({ transcriptExtractionLive: run.summary }));
      expect(run.summary.transmissions).toBeLessThanOrEqual(FROZEN.calls);
      expect(run.summary.notSentCalls).toBe(0);
      expect(run.summary.spend.committedMicroUsd).toBeLessThanOrEqual(Math.round(gate.maxUsd * 1_000_000));
      expect(run.summary.callMap.kind).toBe("MAPPED");
      expect(run.summary.redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      expect(run.summary.hashes.mismatches).toBe(0);
    },
    30 * 60_000,
  );
});
