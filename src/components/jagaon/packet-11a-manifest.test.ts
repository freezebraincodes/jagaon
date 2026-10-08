import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as activation from "@/application/ai/ai-activation-manifest";
import * as lifecycle from "@/application/ai/ai-audit-lifecycle";
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
    expect(exportsOf(port)).toEqual(["PROVIDER_FAILURE_REASONS"]);
    // Packet 11B.6: hybrid language layer (the hybrid service reuses these helpers).
    expect(exportsOf(service)).toEqual(["NO_USAGE", "addUsage", "buildAuditRow", "callOnce", "createAiTaskService"]);
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
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\/|process\.env|KIE_API_KEY|NEXT_PUBLIC_|api\.kie/i);
    }
    // Packet 11B: only the server-only Kie modules and the AI route may name the credential.
    for (const file of walk("src").filter((path) => !/\.test\.tsx?$/.test(path))) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_KIE/);
      if (!file.startsWith("src/ai/kie/") && !file.startsWith("src/app/api/ai/")) expect(source, file).not.toMatch(/KIE_API_KEY/);
    }
    expect(walk("src/app/api").filter((file) => /(^|\/)ai(\/|-)/i.test(file))).toEqual(["src/app/api/ai/task/ai-task-handler.ts", "src/app/api/ai/task/route.test.ts", "src/app/api/ai/task/route.ts"]);
  });

  it("adds no AI route, screen or control and keeps provider modules out of the runtime", () => {
    expect([...ALL_SCREENS].filter((screen) => /AI_|ASSIST/.test(screen))).toEqual([]);
    expect(walk("src/components").filter((file) => /(^|\/)ai(\/|-)/i.test(file))).toEqual([]);
    // Only the local audit row and its Packet 10 reconciliation enter the client runtime.
    expect(CLIENT_GRAPH.filter((file) => /(^|\/)ai(\/|-)/.test(file))).toEqual(["src/application/ai/ai-audit-lifecycle.ts", "src/domain/ai/ai-invocation-audit.ts", "src/domain/ai/ai-task-contracts.ts"]);
    // Packet 11B: the Kie adapter is reachable only from its own server route.
    expect(RUNTIME_GRAPH.filter((file) => file.startsWith("src/ai/") && !importGraph(["src/app/api/ai/task/route.ts"]).includes(file))).toEqual([]);
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
  "src/app/api/onemap/search/onemap-search-handler.ts",
  "src/application/nearby-food/browser-nearby-food.ts",
];
const ENVIRONMENT_READ = /process\.env|import\.meta\.env/;
const PROVIDER_KEY_NAME = /KIE_API_KEY|DEEPSEEK_API_KEY|ONEMAP_ACCESS_TOKEN/;

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
    expect(SOURCES.filter((file) => ENVIRONMENT_READ.test(strip(readFileSync(join(ROOT, file), "utf8"))))).toEqual(["src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]);
    expect(SOURCES.filter((file) => PROVIDER_KEY_NAME.test(readFileSync(join(ROOT, file), "utf8")))).toEqual([
      "src/ai/deepseek/deepseek-catalogue.ts",
      "src/ai/kie/kie-route-config.ts",
      "src/app/api/ai/task/route.ts",
      "src/app/api/onemap/search/route.ts",
    ]);
    for (const file of CLIENT_GRAPH) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/process\.env|import\.meta\.env|KIE_API_KEY|DEEPSEEK_API_KEY|ONEMAP_ACCESS_TOKEN|NEXT_PUBLIC_|\bBearer\b|api\.kie|deepseek\.com|readKieToken|readDeepSeekToken/);
    }
    expect(CLIENT_GRAPH.filter((file) => file.startsWith("src/ai/") || file.startsWith("src/app/api/"))).toEqual([]);
  });

  it("puts the Checkpoint 2 screens in the browser graph without the AI use case, the hybrid service or the care-draft renderer", () => {
    expect(CLIENT_GRAPH).toEqual(expect.arrayContaining(["src/components/jagaon/history/PatternExplanationPanel.tsx", "src/components/jagaon/screens/CareSummaryPreviewScreen.tsx", "src/components/jagaon/screens/RecordedHistoryScreen.tsx"]));
    for (const file of [
      "src/application/ai/explain-pattern.ts",
      "src/application/ai/explain-pattern-request.ts",
      "src/application/ai/ai-hybrid-task-service.ts",
      "src/application/ai/ai-task-service.ts",
      "src/application/ai/language/care-draft-notices.ts",
    ]) {
      expect(CLIENT_GRAPH, file).not.toContain(file);
    }
  });
});
