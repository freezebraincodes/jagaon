import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as activation from "@/application/ai/ai-activation-manifest";
import * as lifecycle from "@/application/ai/ai-audit-lifecycle";
import * as callSupport from "@/application/ai/ai-call-support";
import * as shellRouteContract from "@/application/ai/ai-shell-route-contract";
import * as browserShellClient from "@/application/ai/browser-shell-client";
import * as browserHistoryExplainer from "@/application/ai/browser-history-explainer";
import * as meaningRules from "@/application/ai/ai-meaning-rules";
import * as persistence from "@/application/ai/ai-audit-persistence";
import * as fallbacks from "@/application/ai/ai-fallbacks";
import * as validator from "@/application/ai/ai-output-validator";
import * as port from "@/application/ai/ai-provider-port";
import * as bundles from "@/application/ai/ai-runtime-bundles";
import * as service from "@/application/ai/ai-task-service";
import * as projector from "@/application/ai/detached-payload-projector";
import * as domainAi from "@/domain/ai";
import { AI_TASK_TYPES } from "@/domain/ai";
import { FIXTURE_NOW, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { EMPTY_IN_PROFILE_TABLES, STORAGE_OWNED_CLOSED_CODECS } from "@/storage/closed-row-codecs";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { LOGICAL_STORAGE_SCHEMA_VERSION } from "@/storage/storage-metadata";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { JAGAON_DEXIE_VERSION, JAGAON_STORES_V1 } from "@/storage/table-catalogue";
import { ALL_SCREENS } from "./screen-manifest";

/**
 * Packet 11A release manifest: a provider-neutral, deterministic-only AI
 * foundation. Six registered tasks, no provider, endpoint, credential, prompt
 * or AI UI; one enabled local AI audit table reconciled by Packet 10 deletion
 * and restore; three runtime-governance tables still empty.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path.replaceAll("\\", "/")] : [];
  });
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => join(ROOT, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]!;
      const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!base) continue;
      const target = (extname(base) ? [base] : [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => `${base}${suffix}`)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target) pending.push(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
}

const AI_FILES = [...walk("src/domain/ai"), ...walk("src/application/ai")].sort();
const AI_SOURCES = AI_FILES.filter((file) => !/\.test\.ts$/.test(file) && !file.endsWith("ai-test-fixtures.ts"));
const CLIENT_GRAPH = importGraph(["src/app/page.tsx"]);
const RUNTIME_GRAPH = importGraph(["src/app/page.tsx", ...walk("src/app/api").filter((file) => file.endsWith("route.ts"))]);
const exportsOf = (module: object) => Object.keys(module).sort();

/**
 * Packet 11C Addendum B, Task B2b (D1, owner approval 2026-10-08): the EXACT AI modules of the browser graph (`src/app/page.tsx`), which
 * replaces the Packet 11A three-file pin. It is the transitive closure the app reaches once the history explanation is wired: the local
 * audit row and its Packet 10 reconciliation (11A), the runtime's append-only audit port, the history explainer wiring, the
 * pattern-explanation use case and its request builder, the hybrid task service with its shared call helpers, the browser shell client
 * and the shared route contract, the activation manifest, runtime bundles, fallbacks, the approved-meaning registry and rules, the output
 * validator's locale checks, the detached projector (used locally by the slot planner only), the language modules and `domain/ai`.
 * A new entry is a deliberate change; never a broad relaxation. Still excluded and asserted below: `src/ai/**`, `src/app/api/**`, the
 * legacy `ai-task-service`, any client of `/api/ai/task`, credential and environment readers and provider adapters. The same list is
 * mirrored in packet-9c-manifest.test.ts.
 */
const CLIENT_AI_FILES = [
  "src/application/ai/ai-activation-manifest.ts",
  "src/application/ai/ai-audit-lifecycle.ts",
  "src/application/ai/ai-audit-persistence.ts",
  "src/application/ai/ai-call-support.ts",
  "src/application/ai/ai-fallbacks.ts",
  "src/application/ai/ai-hybrid-runtime-bundles.ts",
  "src/application/ai/ai-hybrid-task-service.ts",
  "src/application/ai/ai-meaning-registry.ts",
  "src/application/ai/ai-meaning-rules.ts",
  "src/application/ai/ai-output-validator.ts",
  "src/application/ai/ai-provider-port.ts",
  "src/application/ai/ai-runtime-bundles.ts",
  "src/application/ai/ai-shell-route-contract.ts",
  "src/application/ai/browser-history-explainer.ts",
  "src/application/ai/browser-shell-client.ts",
  "src/application/ai/detached-payload-projector.ts",
  "src/application/ai/explain-pattern-request.ts",
  "src/application/ai/explain-pattern.ts",
  "src/application/ai/language/ai-composition.ts",
  "src/application/ai/language/ai-language-copy.ts",
  "src/application/ai/language/assembler.ts",
  "src/application/ai/language/atom-renderer.ts",
  "src/application/ai/language/care-draft-notices.ts",
  "src/application/ai/language/default-shells.ts",
  "src/application/ai/language/deterministic-composition.ts",
  "src/application/ai/language/observation-composer.ts",
  "src/application/ai/language/shell-lexicon.ts",
  "src/application/ai/language/shell-projector.ts",
  "src/application/ai/language/shell-validator.ts",
  "src/application/ai/language/slot-planner.ts",
  // Packet 11C Addendum C, Task C1 (deliberate, exactly these two): the generated request-class definitions (plain data) and the
  // qualification records with the class rule and gate (all PENDING), used by the hybrid service and the wiring before any disclosure or
  // send. Neither imports evaluation, prompt, provider or credential code; the test-only support module stays out (pinned below).
  "src/application/ai/request-class-definitions.ts",
  "src/application/ai/request-class-qualification.ts",
  "src/domain/ai/ai-invocation-audit.ts",
  "src/domain/ai/ai-language-shell-contracts.ts",
  "src/domain/ai/ai-task-contracts.ts",
  "src/domain/ai/index.ts",
];
/**
 * Packet 11C Addendum B, Task B4b (D1, deliberate addition): the care-summary AI wording is wired, so exactly the care use case, its
 * source-closed request builder and the validated projection join the browser graph (they live in care-preparation, outside the
 * `src/(application|domain)/ai` filter, so CLIENT_AI_FILES is unchanged). Their own AI imports are all inside CLIENT_AI_FILES.
 */
const CLIENT_CARE_AI_FILES = [
  "src/application/care-preparation/ai-care-summary-replacement.ts",
  "src/application/care-preparation/ai-care-summary-request.ts",
  "src/application/care-preparation/compose-care-summary-with-ai.ts",
];
/** The Packet 11C B1a renderer: the care-preparation module that already reached the approved care-draft notice copy. */
const CARE_NOTICE_RENDERER = "src/application/care-preparation/deterministic-care-summary-renderer.ts";
const BROWSER_SHELL_CLIENT = "src/application/ai/browser-shell-client.ts";
/** Packet 11C B3: the shared AI disclosure dialog, an AI-free presentation component (no AI module in its import graph). */
const AI_DISCLOSURE_DIALOG = "src/components/jagaon/ai/AiDisclosureDialog.tsx";
const AI_DISCLOSURE_DIALOG_TEST = "src/components/jagaon/ai/AiDisclosureDialog.test.tsx";
const DETACHED_PROJECTOR = "src/application/ai/detached-payload-projector.ts";

describe("Packet 11A scope", () => {
  it("adds exactly the planned AI files", () => {
    expect(AI_FILES).toEqual(
      [
        "src/domain/ai/ai-invocation-audit.test.ts",
        "src/domain/ai/ai-invocation-audit.ts",
        "src/domain/ai/ai-task-contracts.test.ts",
        "src/domain/ai/ai-task-contracts.ts",
        "src/domain/ai/ai-test-fixtures.ts",
        "src/domain/ai/index.ts",
        "src/application/ai/ai-activation-manifest.test.ts",
        "src/application/ai/ai-activation-manifest.ts",
        "src/application/ai/ai-audit-lifecycle.test.ts",
        "src/application/ai/ai-audit-lifecycle.ts",
        "src/application/ai/ai-audit-persistence.test.ts",
        "src/application/ai/ai-audit-persistence.ts",
        "src/application/ai/ai-fallbacks.test.ts",
        "src/application/ai/ai-meaning-registry.test.ts",
        "src/application/ai/ai-meaning-registry.ts",
        "src/application/ai/ai-meaning-rules.test.ts",
        "src/application/ai/ai-meaning-rules.ts",
        "src/application/ai/ai-fallbacks.ts",
        "src/application/ai/ai-output-validator.test.ts",
        "src/application/ai/ai-output-validator.ts",
        "src/application/ai/ai-provider-port.ts",
        "src/application/ai/ai-runtime-bundles.test.ts",
        "src/application/ai/ai-runtime-bundles.ts",
        "src/application/ai/ai-task-service.test.ts",
        "src/application/ai/ai-task-service.ts",
        // Packet 11C Task 6A: the legacy fact-sending service refuses a source-backed request (own file: module-wide projector spy).
        "src/application/ai/ai-task-service-source-backed.test.ts",
        "src/application/ai/detached-payload-projector.test.ts",
        "src/application/ai/detached-payload-projector.ts",
        // Packet 11B.6: hybrid language layer
        "src/application/ai/ai-hybrid-runtime-bundles.test.ts",
        "src/application/ai/ai-hybrid-runtime-bundles.ts",
        "src/application/ai/ai-hybrid-task-service.test.ts",
        "src/application/ai/ai-hybrid-task-service.ts",
        // Packet 11C Task 3: the source-backed EXPLAIN_PATTERN request builder.
        "src/application/ai/explain-pattern-request.test.ts",
        "src/application/ai/explain-pattern-request.ts",
        // Packet 11C Task 6: the pattern-explanation use case (stale-source and correction protection; hybrid execute only).
        "src/application/ai/explain-pattern.test.ts",
        "src/application/ai/explain-pattern.ts",
        "src/application/ai/language/ai-language-copy.test.ts",
        "src/application/ai/language/ai-language-copy.ts",
        "src/application/ai/language/assembler.test.ts",
        "src/application/ai/language/assembler.ts",
        "src/application/ai/language/atom-renderer.test.ts",
        "src/application/ai/language/atom-renderer.ts",
        "src/application/ai/language/default-shells.test.ts",
        "src/application/ai/language/default-shells.ts",
        "src/application/ai/language/deterministic-composition.test.ts",
        "src/application/ai/language/deterministic-composition.ts",
        "src/application/ai/language/shell-lexicon.ts",
        "src/application/ai/language/shell-projector.test.ts",
        "src/application/ai/language/shell-projector.ts",
        "src/application/ai/language/shell-validator.test.ts",
        "src/application/ai/language/shell-validator.ts",
        "src/application/ai/language/slot-planner.test.ts",
        "src/application/ai/language/slot-planner.ts",
        // Observation ownership (2026-10-07): the deterministic EXPLAIN observation composer and the shared AI-path composition step
        // (tested together in observation-composer.test.ts).
        "src/application/ai/language/ai-composition.ts",
        "src/application/ai/language/observation-composer.test.ts",
        "src/application/ai/language/observation-composer.ts",
        // Presentation correction P3 (2026-10-08): the fixed bilingual care-draft notices.
        "src/application/ai/language/care-draft-notices.test.ts",
        "src/application/ai/language/care-draft-notices.ts",
        // Packet 11C Addendum B, Task B2a: the provider-call helpers shared by the legacy and hybrid services (moved out of
        // ai-task-service.ts, no behaviour change, so the hybrid service no longer imports the legacy fact-sending service), and the
        // value-blind POST /api/ai/shell response contract (browser-safe: shared by the server route and the B2b browser client).
        "src/application/ai/ai-call-support.ts",
        "src/application/ai/ai-shell-route-contract.ts",
        // Packet 11C Addendum B, Task B2b: the browser client of POST /api/ai/shell (interim fail-closed disclosure) and the browser
        // wiring of the history explanation (one hybrid service, one pattern explainer).
        "src/application/ai/browser-shell-client.test.ts",
        "src/application/ai/browser-shell-client.ts",
        "src/application/ai/browser-history-explainer.test.ts",
        "src/application/ai/browser-history-explainer.ts",
        // Packet 11C Addendum C, Task C1 (owner decision C1): the generated, immutable request-class definitions (plain data, bound to the
        // frozen contract digest), the separate qualification records (all PENDING) with the class rule and gate, its test, and the
        // test-only support that injects test-only QUALIFIED records (never in a production graph; pinned below).
        "src/application/ai/request-class-definitions.ts",
        "src/application/ai/request-class-qualification.test.ts",
        "src/application/ai/request-class-qualification.ts",
        "src/application/ai/request-class-test-support.ts",
        "src/domain/ai/ai-language-shell-contracts.test.ts",
        "src/domain/ai/ai-language-shell-contracts.ts",
      ].sort(),
    );
  });

  it("exports exactly the planned AI contracts", () => {
    expect(exportsOf(activation)).toEqual(["AI_ACTIVATION_MANIFEST", "AI_ACTIVATION_STATES", "resolveAiTaskActivation"]);
    expect(exportsOf(bundles)).toEqual(["AI_BUNDLE_VERSION", "AI_TASK_RUNTIME_BUNDLES", "resolveAiTaskBundle"]);
    expect(exportsOf(fallbacks)).toEqual(["AI_REASON_CODES", "aiFallbackPresentationSchema", "aiFallbackResultSchema", "aiReasonCodeSchema", "createDeterministicFallback"]);
    expect(exportsOf(projector)).toEqual(["AI_FIELD_ALLOWLISTS", "REDACTION_TOKEN", "projectProviderTaskPayload", "redactSelectedText"]);
    // Packet 11B.6: hybrid language layer (the shell validator reuses the locale and spelled-count checks).
    expect(exportsOf(validator)).toEqual(["OUTPUT_CODE_POINTS_PER_TOKEN", "localeTextAccepted", "spelledCounts", "validateAiTaskOutput"]);
    // Packet 11B corrective pass: shared immutable meaning rules for the validator and the evaluation-only diagnostic.
    expect(exportsOf(meaningRules)).toEqual(["MEANING_RULES", "generatedTextFields", "meaningMatches", "meaningScanText", "withoutQuotations"]);
    // Packet 11C B2a (D6): the closed reasons of the typed structural rejection a server shell gate may return.
    expect(exportsOf(port)).toEqual(["PROVIDER_FAILURE_REASONS", "SHELL_STRUCTURAL_REJECTION_REASONS"]);
    // Packet 11B.6 had the hybrid service reuse these helpers from the legacy service. Packet 11C B2a (deliberate retarget) moved them,
    // unchanged, to the shared ai-call-support module, so the legacy service exports only its factory.
    expect(exportsOf(service)).toEqual(["createAiTaskService"]);
    // Packet 11C B3 (deliberate): the remote-use decision moved here from the B2b client, shared by the hybrid service and the client.
    // Packet 11C Addendum C, C5 (deliberate): plus the conservative per-attempt usage count.
    expect(exportsOf(callSupport)).toEqual(["NO_USAGE", "addAttemptUsage", "addUsage", "buildAuditRow", "callOnce", "decideRemoteUse"]);
    // Packet 11C Addendum C, C5 (deliberate): plus the shared pre-send upper bound of one shell call (prices, margin, body overhead, the
    // exact-body and the route-request bounds) and the FAILED reasons that may carry usage. Browser-safe: no credential, prompt or network.
    expect(exportsOf(shellRouteContract)).toEqual([
      // Packet 11C Addendum C, C6 (deliberate): the request header carrying the demo passcode (a header name only, no value).
      "AI_SHELL_ACCESS_HEADER",
      "AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS",
      "AI_SHELL_MAX_BODY_BYTES",
      "AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES",
      "AI_SHELL_ROUTE_PATH",
      "AI_SHELL_ROUTE_PEAK_USD_PER_MILLION",
      "AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS",
      // Packet 11C Addendum C, C1 (deliberate): the route's closed REFUSED reasons (REQUEST_CLASS_NOT_QUALIFIED).
      "AI_SHELL_ROUTE_REFUSAL_REASONS",
      "aiShellRouteResponseSchema",
      "shellCallUpperBound",
      "shellRouteCallUpperBound",
    ]);
    // Packet 11C B2b: no production module exports a disclosure that accepts remote use by itself. Packet 11C Addendum C, C3 (deliberate
    // retarget of the B3 session): the per-request decisions accept only the one request the screen passes "ACCEPTED" with, which only
    // the disclosure dialog's primary action does (pinned below).
    // CL3 contract re-freeze (Task RF, deliberate): plus the label of that per-request disclosure policy (a string only; pinned by the
    // contract freeze with the behaviour).
    expect(exportsOf(browserShellClient)).toEqual(["AI_DISCLOSURE_POLICY_VERSION", "BROWSER_SHELL_CLIENT_PROVIDER_MODEL", "INTERIM_FAIL_CLOSED_DISCLOSURE", "createAiRemoteUseDecisions", "createBrowserShellClient"]);
    // Packet 11C B4b (deliberate): the one AI wiring of both flows (history explanation and care-summary wording) over one hybrid service.
    expect(exportsOf(browserHistoryExplainer)).toEqual(["createBrowserAiAssistance", "createBrowserHistoryExplainer"]);
    expect(exportsOf(persistence)).toEqual(["createAiInvocationAuditRepository"]);
    expect(exportsOf(lifecycle)).toEqual(["AI_AUDIT_REFERENCE_KEYS", "aiAuditReferencesIn", "aiAuditsAffectedByDeletion", "validateAiAuditReferences"]);
    for (const name of ["AI_TASK_TYPES", "aiTaskRequestSchema", "aiTaskOutputSchema", "providerTaskRequestSchema", "providerTaskOutputSchema", "AI_REASON_CODES", "aiInvocationAuditRowSchema", "AI_INVOCATION_OUTCOME_CODES"]) {
      expect(exportsOf(domainAi)).toContain(name);
    }
  });

  it("registers exactly six tasks, every one deterministic-only under the shipped manifest", () => {
    expect(AI_TASK_TYPES).toEqual(["EXTRACT_CANDIDATE_FACTS", "EXPLAIN_PATTERN", "DRAFT_NEUTRAL_INQUIRY", "ANSWER_BOUNDED_RECORD_QUERY", "DRAFT_CARE_PREPARATION_SUMMARY", "PHRASE_NON_CLINICAL_RESPONSE"]);
    expect(Object.values(activation.AI_ACTIVATION_MANIFEST.tasks)).toEqual(Array(6).fill("DETERMINISTIC_ONLY"));
    for (const taskType of AI_TASK_TYPES) {
      expect(activation.resolveAiTaskActivation(taskType, "HACKATHON_DEMO")).toEqual({ state: "DETERMINISTIC_ONLY", reason: "TASK_DISABLED" });
      const bundle = bundles.AI_TASK_RUNTIME_BUNDLES[taskType];
      expect(bundle).toMatchObject({ routeProfile: "deterministic-only.11a.1", modelSnapshot: null, executionBudget: { monetaryCeilingUsd: null } });
      expect(bundle.promptTemplate.version).toBe("11a.1-absent");
    }
  });

  it("works offline: every shipped task falls back without touching a provider", async () => {
    const invoke = vi.fn();
    const ai = service.createAiTaskService({ releaseProfile: "HACKATHON_DEMO", provider: { providerModel: { providerKey: "never", modelSnapshot: "never" }, invoke }, audit: { append: async () => undefined }, now: () => FIXTURE_NOW, monotonicMs: () => 0 });
    for (const taskType of AI_TASK_TYPES) expect(await ai.execute(requestFixture(taskType))).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TASK_DISABLED" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("has no provider endpoint, network call, credential, environment read or browser secret", () => {
    for (const file of AI_SOURCES) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      // "Kie.ai" may appear only as an untranslated product name (matrix Section 1), never as an endpoint.
      expect(source, file).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\/|process\.env|KIE_API_KEY|NEXT_PUBLIC_|api\.kie/i);
      // Packet 11C B2b (Addendum B, D1; deliberate, exactly one file): the browser shell client is the only AI module with a network call,
      // its single same-origin POST to the relative path /api/ai/shell. Every other AI module still has none.
      if (file === BROWSER_SHELL_CLIENT) expect(source.match(/\bfetch\s*\(/g), file).toHaveLength(1);
      else expect(source, file).not.toMatch(/\bfetch\s*\(/i);
    }
    // Packet 11B: only the server-only Kie modules and the AI route may name the credential.
    for (const file of walk("src").filter((path) => !/\.test\.tsx?$/.test(path))) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_KIE/);
      if (!file.startsWith("src/ai/kie/") && !file.startsWith("src/app/api/ai/")) expect(source, file).not.toMatch(/KIE_API_KEY/);
    }
    // Packet 11C B2a (deliberate retarget): the value-blind shell route is added beside the retired legacy task route.
    // Packet 11C Addendum C, C5 (deliberate): plus one test-only file (the route's re-parse usage path, isolated for its module mock).
    // Packet 11C Addendum C, C6 (deliberate): the route's server-only deployment configuration and spend ledger modules, their tests and
    // one test-only support module (test configuration values; in no production graph, pinned below).
    expect(walk("src/app/api").filter((file) => /(^|\/)ai(\/|-)/i.test(file))).toEqual([
      "src/app/api/ai/shell/ai-shell-deployment-config.ts",
      "src/app/api/ai/shell/ai-shell-handler.ts",
      "src/app/api/ai/shell/ai-shell-route-test-support.ts",
      "src/app/api/ai/shell/ai-spend-ledger.test.ts",
      "src/app/api/ai/shell/ai-spend-ledger.ts",
      "src/app/api/ai/shell/route-access-spend.test.ts",
      "src/app/api/ai/shell/route-reparse-usage.test.ts",
      "src/app/api/ai/shell/route.test.ts",
      "src/app/api/ai/shell/route.ts",
      "src/app/api/ai/task/ai-task-handler.ts",
      "src/app/api/ai/task/route.test.ts",
      "src/app/api/ai/task/route.ts",
      "src/app/api/ai/transcript/route.test.ts",
      "src/app/api/ai/transcript/route.ts",
      "src/app/api/ai/transcript/transcript-extraction-handler.ts",
    ]);
  });

  it("adds no AI route, screen or control and keeps provider modules out of the runtime", () => {
    expect([...ALL_SCREENS].filter((screen) => /AI_|ASSIST/.test(screen))).toEqual([]);
    // Packet 11C B3 (deliberate retarget): exactly one AI component, the shared disclosure dialog, which is AI-free (pinned below).
    expect(walk("src/components").filter((file) => /(^|\/)ai(\/|-)/i.test(file))).toEqual([AI_DISCLOSURE_DIALOG_TEST, AI_DISCLOSURE_DIALOG]);
    // Packet 11A: only the local audit row and its Packet 10 reconciliation entered the client runtime. Packet 11C B2b (D1, deliberate
    // retarget): the client graph's AI modules are now exactly the enumerated B2b closure, and nothing under src/ai or src/app/api.
    // Packet 11C B3: the path filter also matches the AI-free disclosure dialog component (no AI application module was added).
    // Packet 11C B4b (deliberate): and the two `ai-` care-preparation modules of the enumerated care closure below.
    expect(CLIENT_GRAPH.filter((file) => /(^|\/)ai(\/|-)/.test(file))).toEqual([...CLIENT_AI_FILES, AI_DISCLOSURE_DIALOG, ...CLIENT_CARE_AI_FILES.filter((file) => /\/ai-/.test(file))].sort());
    expect(CLIENT_GRAPH.filter((file) => /^src\/(application|domain)\/ai\//.test(file))).toEqual(CLIENT_AI_FILES);
    // Packet 11C B4b: the care-preparation modules of the browser graph that import an AI module are exactly the B1a notice renderer and
    // the enumerated care closure; every AI module they import is in CLIENT_AI_FILES.
    const importsAi = (file: string) => [...readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2]!).filter((specifier) => /^@\/(application|domain)\/ai(\/|$)/.test(specifier));
    expect(CLIENT_GRAPH.filter((file) => file.startsWith("src/application/care-preparation/") && importsAi(file).length > 0)).toEqual([...CLIENT_CARE_AI_FILES, CARE_NOTICE_RENDERER].sort());
    for (const file of CLIENT_CARE_AI_FILES) expect(CLIENT_GRAPH, file).toContain(file);
    expect(importGraph(CLIENT_CARE_AI_FILES).filter((file) => /^src\/(application|domain)\/ai\//.test(file)).every((file) => CLIENT_AI_FILES.includes(file))).toBe(true);
    expect(importGraph(CLIENT_CARE_AI_FILES).filter((file) => file.startsWith("src/ai/") || file.startsWith("src/app/") || file.endsWith("ai-task-service.ts"))).toEqual([]);
    // The dialog imports no AI module, reads no storage and sends nothing.
    expect(importGraph([AI_DISCLOSURE_DIALOG]).filter((file) => /^src\/(ai|app|application|domain\/ai)\//.test(file))).toEqual([]);
    expect(strip(readFileSync(join(ROOT, AI_DISCLOSURE_DIALOG), "utf8"))).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB/);
    // Packet 11B: the provider adapters are reachable only from the server AI route. Packet 11C B2a (deliberate retarget): that route is
    // now the value-blind POST /api/ai/shell; the retired POST /api/ai/task reaches no provider adapter, AI service or credential reader.
    expect(RUNTIME_GRAPH.filter((file) => file.startsWith("src/ai/") && !importGraph(["src/app/api/ai/shell/route.ts", "src/app/api/ai/transcript/route.ts"]).includes(file))).toEqual([]);
    expect(importGraph(["src/app/api/ai/task/route.ts"]).filter((file) => /^src\/(ai|application\/ai|domain\/ai)\//.test(file))).toEqual([]);
    // The shared-helper extraction keeps the legacy fact-sending service out of the hybrid service's graph and the shell route's graph.
    // Packet 11C Addendum C, C1: the test-only request-class support (test-only QUALIFIED records) and the evaluation-only definitions
    // generator are in no production graph (the browser page and every API route); the route reaches the shipped records only.
    for (const file of ["src/application/ai/request-class-test-support.ts", "src/ai/evaluation/packet-11c-request-class-generator.ts"]) expect(RUNTIME_GRAPH, file).not.toContain(file);
    // Packet 11C Addendum C, C6: the route's test-only configuration values are in no production graph; the route reaches its server-only
    // configuration and ledger modules, which the browser graph never reaches.
    expect(RUNTIME_GRAPH).not.toContain("src/app/api/ai/shell/ai-shell-route-test-support.ts");
    expect(importGraph(["src/app/api/ai/shell/route.ts"])).toEqual(expect.arrayContaining(["src/app/api/ai/shell/ai-shell-deployment-config.ts", "src/app/api/ai/shell/ai-spend-ledger.ts"]));
    for (const file of ["src/app/api/ai/shell/ai-shell-deployment-config.ts", "src/app/api/ai/shell/ai-spend-ledger.ts"]) expect(CLIENT_GRAPH, file).not.toContain(file);
    expect(RUNTIME_GRAPH.filter((file) => file.startsWith("src/ai/evaluation/"))).toEqual([]);
    expect(importGraph(["src/app/api/ai/shell/route.ts"])).toEqual(expect.arrayContaining(["src/application/ai/request-class-definitions.ts", "src/application/ai/request-class-qualification.ts"]));
    expect(importGraph(["src/application/ai/request-class-definitions.ts"]).filter((file) => file !== "src/application/ai/request-class-definitions.ts" && !file.startsWith("src/domain/"))).toEqual([]);
    expect(importGraph(["src/application/ai/ai-hybrid-task-service.ts"])).not.toContain("src/application/ai/ai-task-service.ts");
    expect(importGraph(["src/app/api/ai/shell/route.ts"])).not.toContain("src/application/ai/ai-task-service.ts");
  });

  it("imports no Safety, Packet 12 or deferred Packet 7B module", () => {
    for (const file of AI_SOURCES) {
      const imports = [...readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2]!);
      expect(imports.filter((specifier) => /safety|packet-?12|7b|routine-shift|recurring-barrier|prescribed-timing|barrier-learning/i.test(specifier)), file).toEqual([]);
    }
    expect(RUNTIME_GRAPH.filter((file) => /packet-?12|packet-?7b/i.test(file))).toEqual([]);
  });

  it("enables one AI audit codec, keeps three runtime tables empty and changes no storage version or index", () => {
    expect(EMPTY_IN_PROFILE_TABLES).toEqual(["runtimeManifests", "governedAssets", "runtimeActivationAudits"]);
    expect(HACKATHON_STORAGE_PROFILE.emptyTables).toEqual(["runtimeManifests", "governedAssets", "runtimeActivationAudits"]);
    expect(STORAGE_OWNED_CLOSED_CODECS.aiInvocationAudits).toBe(implementedStorageRowCodecs.aiInvocationAudits);
    expect(HACKATHON_STORAGE_PROFILE.backupTables).toContain("aiInvocationAudits");
    expect(JAGAON_DEXIE_VERSION).toBe(2);
    expect(LOGICAL_STORAGE_SCHEMA_VERSION).toBe(1);
    expect(JAGAON_STORES_V1.aiInvocationAudits).toBe("requestId, taskType, requestedAt, outcomeCode, routeProfileKey, [taskType+requestedAt]");
  });
});

/**
 * Packet 11C Checkpoint 2 (Task 9): no activation change, no new network call site and no browser credential. The allow-lists name
 * the modules that held these before Checkpoint 2, exactly; a new entry is a stop for the owner, never an allow-list edit.
 */
const SOURCES = walk("src")
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .sort();
/** A network call site: a `fetch` call or the global `fetch` bound as a default fetcher, or another browser network primitive. */
const NETWORK_CALL_SITE = /(?<![.\w$])fetch\b(?!\s*:)|(?:globalThis|window|self)\s*\.\s*fetch\b|\[\s*["'`]fetch["'`]\s*\]|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;
const EXISTING_NETWORK_MODULES = [
  "src/ai/kie/kie-model-catalogue.ts",
  "src/ai/kie/kie-responses-provider.ts",
  // Packet 13 (P13X, owner scope expansion 2026-10-09): the transcript-extraction transport's one bounded POST to the documented DeepSeek endpoint (server-only).
  "src/ai/transcript-extraction/transcript-extraction-provider.ts",
  "src/app/api/onemap/search/onemap-search-handler.ts",
  // Packet 11C Addendum B, Task B2b (owner-approved design, D1): the browser shell client's single same-origin POST to /api/ai/shell.
  // It is the one deliberate addition; it sends only after the request passed the client-side checks and an accepted disclosure, and
  // the shipped manifest keeps every task NOT_ACTIVATED, so the shipped app never reaches it (B3: nor is the disclosure ever shown).
  "src/application/ai/browser-shell-client.ts",
  "src/application/nearby-food/browser-nearby-food.ts",
  // Packet 13 (P13X): the transcript-extraction browser client's single same-origin POST to /api/ai/transcript.
  "src/application/transcript-extraction/transcript-extraction-client.ts",
  // Packet 13 slice (P13S, S7; owner decisions 3 and 4, 2026-10-09: server-side UserSig and the real TRTC adapter authorized): the
  // voice credential client's single same-origin POST to /api/voice/usersig. Not in the browser graph until the Tell JagaOn screen
  // (Q13-5) loads it by dynamic import after the voice-cloud disclosure.
  "src/voice/trtc/trtc-credential-client.ts",
];
const ENVIRONMENT_READ = /process\.env|import\.meta\.env/;
const PROVIDER_KEY_NAME = /KIE_API_KEY|DEEPSEEK_API_KEY|ONEMAP_ACCESS_TOKEN|TRTC_SDK_SECRET_KEY/;

describe("Packet 11C Checkpoint 2 guards", () => {
  it("activates nothing: every task stays DETERMINISTIC_ONLY under HACKATHON_DEMO and none is SYNTHETIC_REMOTE_ENABLED", () => {
    expect(activation.AI_ACTIVATION_MANIFEST.profile).toBe("HACKATHON_DEMO");
    expect(Object.entries(activation.AI_ACTIVATION_MANIFEST.tasks).filter(([, state]) => state !== "DETERMINISTIC_ONLY")).toEqual([]);
  });

  it("detects a network call site (positive control for the scan below)", () => {
    for (const sample of ["fetch(url)", "const f = options.fetcher ?? fetch;", "await globalThis.fetch(url)", "window['fetch'](url)", "new XMLHttpRequest()", "navigator.sendBeacon(url)"]) {
      expect(sample, sample).toMatch(NETWORK_CALL_SITE);
    }
    for (const sample of ["const fetcher = options.fetcher;", "fetcher(input, init)", "{ fetch: false }", "refetch()"]) expect(sample, sample).not.toMatch(NETWORK_CALL_SITE);
  });

  it("adds no network call site outside the existing modules", () => {
    expect(SOURCES.filter((file) => NETWORK_CALL_SITE.test(strip(readFileSync(join(ROOT, file), "utf8"))))).toEqual(EXISTING_NETWORK_MODULES);
  });

  it("keeps every credential and environment read out of the browser graph", () => {
    // Only the two server routes read the environment, and only server-only modules name a provider key.
    // Packet 11C B2a (deliberate retarget): the environment-reading AI route is now the value-blind shell route; the retired legacy task
    // route reads no environment and names no key. The shell route reads its credential only through readDeepSeekToken (catalogue).
    // Packet 13 slice (P13S, S7; owner decisions 3 and 4): plus the voice UserSig route, whose only server-only configuration module names
    // the TRTC signing secret (read last, after every refusal; never returned).
    expect(SOURCES.filter((file) => ENVIRONMENT_READ.test(strip(readFileSync(join(ROOT, file), "utf8"))))).toEqual(["src/app/api/ai/shell/route.ts", "src/app/api/ai/transcript/route.ts", "src/app/api/onemap/search/route.ts", "src/app/api/voice/usersig/route.ts"]);
    expect(SOURCES.filter((file) => PROVIDER_KEY_NAME.test(readFileSync(join(ROOT, file), "utf8")))).toEqual([
      "src/ai/deepseek/deepseek-catalogue.ts",
      "src/ai/kie/kie-route-config.ts",
      "src/app/api/onemap/search/route.ts",
      "src/app/api/voice/usersig/voice-usersig-config.ts",
    ]);
    for (const file of CLIENT_GRAPH) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/process\.env|import\.meta\.env|KIE_API_KEY|DEEPSEEK_API_KEY|ONEMAP_ACCESS_TOKEN|NEXT_PUBLIC_|\bBearer\b|api\.kie|deepseek\.com|readKieToken|readDeepSeekToken|TRTC_SDK_SECRET_KEY|tls-sig-api-v2/);
    }
    expect(CLIENT_GRAPH.filter((file) => file.startsWith("src/ai/") || file.startsWith("src/app/api/"))).toEqual([]);
  });

  /**
   * Checkpoint 2 kept the AI use case, the hybrid service and the care-draft renderer out of the browser graph. Packet 11C B2b (D1,
   * deliberate retarget): the history explanation is now wired, so they are in it as part of the exact enumerated closure above; the
   * legacy fact-sending service stays out.
   */
  it("puts the Checkpoint 2 screens and the wired history explanation in the browser graph, never the legacy fact-sending service", () => {
    expect(CLIENT_GRAPH).toEqual(expect.arrayContaining(["src/components/jagaon/history/PatternExplanationPanel.tsx", "src/components/jagaon/screens/CareSummaryPreviewScreen.tsx", "src/components/jagaon/screens/RecordedHistoryScreen.tsx"]));
    expect(CLIENT_GRAPH).toEqual(expect.arrayContaining(["src/application/ai/browser-history-explainer.ts", "src/application/ai/explain-pattern.ts", "src/application/ai/explain-pattern-request.ts", "src/application/ai/ai-hybrid-task-service.ts", "src/application/ai/browser-shell-client.ts"]));
    // Packet 11C B4b: and the wired care-summary AI wording use case.
    expect(CLIENT_GRAPH).toContain("src/application/care-preparation/compose-care-summary-with-ai.ts");
    expect(CLIENT_GRAPH).not.toContain("src/application/ai/ai-task-service.ts");
    // The wiring enters through the app shell only: the history screen and the panel import no AI module themselves. Packet 11C B3
    // (deliberate retarget): the screen imports exactly the AI-free disclosure dialog component, nothing else under an `ai` path.
    // Packet 11C B4b (deliberate): so does the care-summary preview screen.
    const aiImports = (file: string) => [...readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2]!).filter((specifier) => /\/ai\/|\/ai-|-ai$/.test(specifier));
    expect(aiImports("src/components/jagaon/screens/RecordedHistoryScreen.tsx")).toEqual(["../ai/AiDisclosureDialog"]);
    expect(aiImports("src/components/jagaon/history/PatternExplanationPanel.tsx")).toEqual([]);
    expect(aiImports("src/components/jagaon/screens/CareSummaryPreviewScreen.tsx")).toEqual(["../ai/AiDisclosureDialog"]);
    // Only the dialog's primary action accepts remote use. Packet 11C Addendum C, C3 (deliberate retarget of the B3/B4b session pins):
    // there is no accept() call anywhere in the app graph any more; the "ACCEPTED" decision is created in exactly one place per flow, the
    // dialog's onConfirm handler, and travels with that one request.
    const acceptCallers = CLIENT_GRAPH.filter((file) => !file.startsWith("src/application/ai/") && /\.accept(Disclosure)?\?*\.?\(/.test(strip(readFileSync(join(ROOT, file), "utf8"))));
    expect(acceptCallers).toEqual([]);
    const decisionSites = CLIENT_GRAPH.filter((file) => file.startsWith("src/components/") && /"ACCEPTED"\s*\)/.test(strip(readFileSync(join(ROOT, file), "utf8"))));
    expect(decisionSites).toEqual(["src/components/jagaon/screens/CareSummaryPreviewScreen.tsx", "src/components/jagaon/screens/RecordedHistoryScreen.tsx"]);
    const historyScreen = strip(readFileSync(join(ROOT, "src/components/jagaon/screens/RecordedHistoryScreen.tsx"), "utf8"));
    expect(historyScreen.match(/"ACCEPTED"\s*\)/g)).toHaveLength(1);
    expect(historyScreen).toMatch(/const acceptDisclosure = useCallback\(\(\) => \{\s*if \(!shownDisclosure\) return;\s*decidedDisclosures\.current\.add\(shownDisclosure\);\s*setPendingDisclosure\(null\);\s*openExplanation\(shownDisclosure\.factId, "ACCEPTED"\);/);
    expect(historyScreen).toMatch(/onConfirm=\{acceptDisclosure\}/);
    const careScreen = strip(readFileSync(join(ROOT, "src/components/jagaon/screens/CareSummaryPreviewScreen.tsx"), "utf8"));
    expect(careScreen.match(/"ACCEPTED"\s*\)/g)).toHaveLength(1);
    expect(careScreen).toMatch(/function acceptAiDisclosure\(\) \{\s*if \(aiPhase\.kind !== "DISCLOSURE" \|\| !aiWording\) return;\s*decidedDisclosures\.current\.add\(aiPhase\);\s*runAiWording\("ACCEPTED"\);/);
    expect(careScreen).toMatch(/onConfirm=\{acceptAiDisclosure\}/);

    // C3 fix round 1 (broadened): a literal scan of the WHOLE client graph (comments stripped). Any "ACCEPTED" string literal (in any
    // quote, as an object literal, `as const`, a variable or an argument) is allowed only in this exact list of files; a new file with
    // one fails here. Outside the remote-use decision machinery the literal is either a type, the one dialog handler per screen, or an
    // unrelated closed vocabulary (the audit outcome ACCEPTED, the validator's and composer's ACCEPTED result kinds).
    const ACCEPTED_LITERAL = /(["'`])ACCEPTED\1/;
    const acceptedFiles = CLIENT_GRAPH.filter((file) => ACCEPTED_LITERAL.test(strip(readFileSync(join(ROOT, file), "utf8"))));
    expect(acceptedFiles).toEqual(
      [
        // The remote-use decision machinery: the per-request decisions and the client (browser-shell-client), the decision type
        // (ai-provider-port), the shared decision helper (ai-call-support) and the service that reads the decision once.
        "src/application/ai/browser-shell-client.ts",
        "src/application/ai/ai-provider-port.ts",
        "src/application/ai/ai-call-support.ts",
        "src/application/ai/ai-hybrid-task-service.ts",
        // The two screens (the one dialog handler each, pinned above, plus types) and the panel's port type.
        "src/components/jagaon/screens/RecordedHistoryScreen.tsx",
        "src/components/jagaon/screens/CareSummaryPreviewScreen.tsx",
        "src/components/jagaon/history/PatternExplanationPanel.tsx",
        // Unrelated closed vocabularies: the audit outcome ACCEPTED and the validator's or composer's ACCEPTED result kind.
        "src/domain/ai/ai-invocation-audit.ts",
        "src/application/ai/ai-audit-lifecycle.ts",
        "src/application/ai/ai-output-validator.ts",
        "src/application/ai/language/ai-composition.ts",
        "src/application/care-preparation/care-preparation-service.ts",
        "src/application/care-preparation/ai-care-summary-replacement.ts",
        // Packet 13 (P13X, deliberate): the transcript-extraction client reads the per-request decision before its one POST, and the
        // voice adapter binds the voice screen's own disclosure acceptance to exactly that one call (createAiRemoteUseDecisions().run).
        "src/application/transcript-extraction/transcript-extraction-client.ts",
        "src/application/transcript-extraction/voice-remote-extraction-adapter.ts",
      ].sort(),
    );
    // Nowhere in the graph is a decision written as an object field, a const assertion or a stored value outside the screens' handlers.
    for (const file of CLIENT_GRAPH) {
      const source = strip(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toMatch(/disclosure\s*:\s*(["'`])ACCEPTED\1|(["'`])ACCEPTED\2\s+as\s+const|(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(["'`])ACCEPTED\3/);
    }
    // In the components, after removing type unions, the literal is left only at the one dialog handler per screen.
    const valueLiterals = (file: string) => (strip(readFileSync(join(ROOT, file), "utf8")).replace(/(["'`])ACCEPTED\1\s*\|/g, "").match(/(["'`])ACCEPTED\1/g) ?? []).length;
    expect(valueLiterals("src/components/jagaon/screens/RecordedHistoryScreen.tsx")).toBe(1);
    expect(valueLiterals("src/components/jagaon/screens/CareSummaryPreviewScreen.tsx")).toBe(1);
    expect(valueLiterals("src/components/jagaon/history/PatternExplanationPanel.tsx")).toBe(0);
    // Positive controls for the scan.
    for (const sample of ['const d = "ACCEPTED";', "x({ disclosure: 'ACCEPTED' })", "const y = `ACCEPTED` as const;"]) expect(sample, sample).toMatch(/disclosure\s*:\s*(["'`])ACCEPTED\1|(["'`])ACCEPTED\2\s+as\s+const|(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(["'`])ACCEPTED\3/);
  });
});

/**
 * Packet 11C Addendum B, Task B2b (D1 and the B-boundary): what the browser graph may and may not do with its AI modules.
 */
describe("Packet 11C B2b browser boundary", () => {
  const source = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const importsOf = (file: string) => [...source(file).matchAll(IMPORT)].map((match) => match[1] ?? match[2]!);

  it("keeps server-only and legacy modules out: no src/ai, src/app/api, legacy service, legacy route client, credential or environment reader", () => {
    expect(CLIENT_GRAPH.filter((file) => file.startsWith("src/ai/") || file.startsWith("src/app/api/"))).toEqual([]);
    expect(CLIENT_GRAPH).not.toContain("src/application/ai/ai-task-service.ts");
    for (const file of CLIENT_GRAPH) {
      expect(strip(source(file)), file).not.toMatch(/\/api\/ai\/task|createAiTaskService|readKieToken|readDeepSeekToken|create\w*ResponsesProvider|process\.env|import\.meta\.env/);
      expect(importsOf(file).filter((specifier) => specifier.startsWith("@/ai/") || specifier.startsWith("@/app/") || /ai-task-service$/.test(specifier)), file).toEqual([]);
    }
  });

  it("6A follow-up: no browser module sends projectProviderTaskPayload output; only the planner and the output validator import the projector, and none of them sends", () => {
    const importers = CLIENT_GRAPH.filter((file) => file !== DETACHED_PROJECTOR && importsOf(file).some((specifier) => /detached-payload-projector$/.test(specifier)));
    // Packet 11C B4b (deliberate retarget): the care request builder joins the browser graph. It imports only the projector's
    // `redactSelectedText`, as a local sendability check (a label or question the projector would redact is never sent); it never calls
    // or names projectProviderTaskPayload and is not a network call site.
    const CARE_REQUEST = "src/application/care-preparation/ai-care-summary-request.ts";
    expect(importers).toEqual(["src/application/ai/ai-output-validator.ts", "src/application/ai/language/slot-planner.ts", CARE_REQUEST]);
    expect(source(CARE_REQUEST)).toMatch(/^import \{ redactSelectedText \} from "@\/application\/ai\/detached-payload-projector";$/m);
    const mentions = CLIENT_GRAPH.filter((file) => file !== DETACHED_PROJECTOR && /projectProviderTaskPayload/.test(strip(source(file))));
    expect(mentions).toEqual(importers.filter((file) => file !== CARE_REQUEST));
    // Neither the projector nor any module that imports it is a network call site.
    for (const file of [DETACHED_PROJECTOR, ...importers]) expect(strip(source(file)), file).not.toMatch(NETWORK_CALL_SITE);
    // The only AI network call site in the browser graph is the shell client. It imports neither the projector nor any of its importers,
    // and it sends exactly the strictly parsed value-blind ShellTaskRequest it was given, to the relative shell route path.
    expect(CLIENT_AI_FILES.filter((file) => NETWORK_CALL_SITE.test(strip(source(file))))).toEqual([BROWSER_SHELL_CLIENT]);
    const client = source(BROWSER_SHELL_CLIENT);
    expect(importsOf(BROWSER_SHELL_CLIENT).filter((specifier) => /detached-payload-projector|slot-planner|ai-output-validator/.test(specifier))).toEqual([]);
    expect(client).not.toMatch(/projectProviderTaskPayload|ProviderTaskRequest\b/);
    expect(client).toMatch(/shellTaskRequestSchema\.safeParse\(input\)/);
    expect(client).toMatch(/const body = JSON\.stringify\(parsed\.data\);/);
    // Packet 11C Addendum C, C6 (deliberate): plus the one demo-passcode request header (never in the body; the body is unchanged).
    expect(client).toMatch(/fetcher\(AI_SHELL_ROUTE_PATH, \{ method: "POST", headers: \{ "content-type": "application\/json", \.\.\.passcodeHeader\(options\.accessPasscode\) \}, body, cache: "no-store", redirect: "error", signal \}\)/);
  });
});
