#!/usr/bin/env node
/**
 * Packet 12A A2: refusing release suite runner.
 *
 *   node scripts/release/run-suite.mjs <suite> [--list] [--run] [--root <serve-root>] [--build-dir <dir>] [--summary <file>]
 *
 * Resolves the closed file list from release/suite-manifest.json and runs `vitest run --reporter=json --outputFile=<tmp> <files>` (in
 * the checkout) or `playwright test --config <config> --reporter=json <files>` (in the serve root, normally a clean export holding the
 * candidate build). `--run` is accepted and ignored (npm pass-through); `--list` prints the resolved list and starts no child. No
 * `--env-file` is ever passed. The child environment drops every inherited secret and every `JAGAON_*`, `NEXT_PUBLIC_*`, `DEEPSEEK_*`,
 * `KIE_*`, `TRTC_*`, `ONEMAP_*` and `RUN_LIVE_*` name, and adds only the runner-owned control variables below. Standalone, a served suite
 * (browser, e2e, accessibility) is refused unless `--root` names a clean export that is not the checkout and holds no `.env*` file
 * (`.env.example` excepted). The run is refused (non-zero exit, named reason) on: a missing file, an empty suite, a
 * collected file count or set that differs from the manifest, zero passed tests, any skipped/todo/pending test, any failure, any
 * Playwright retry or top-level error, a non-zero child exit, or an unreadable JSON report.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isEnvSecretFileName } from "./release-core.mjs";
import { SUITE_NAMES, loadSuiteManifest } from "./suite-manifest.mjs";

/** Exact names of the shared secret/switch contract (with stream 2). Prefix families are stripped below as well. */
export const STRIPPED_ENV_NAMES = Object.freeze(["DEEPSEEK_API_KEY", "KIE_API_KEY", "ONEMAP_ACCESS_TOKEN", "TRTC_SDK_SECRET_KEY", "TRTC_SDK_APP_ID"]);
export const STRIPPED_ENV_PREFIXES = Object.freeze(["JAGAON_", "NEXT_PUBLIC_", "DEEPSEEK_", "KIE_", "TRTC_", "ONEMAP_", "RUN_LIVE_"]);
/** Suites served by Playwright from a serve root: run standalone, they need a clean export, never the checkout. */
export const SERVED_SUITES = Object.freeze(["browser", "e2e", "accessibility"]);
/** The only variables the runner adds. JAGAON_RELEASE makes Playwright start fresh servers (Q12-2); the build dir feeds B1/B8. */
export const RUNNER_CONTROL_VARIABLES = Object.freeze(["JAGAON_RELEASE", "JAGAON_RELEASE_BUILD_DIR", "PLAYWRIGHT_JSON_OUTPUT_NAME"]);

export function isStrippedEnvName(name) {
  return STRIPPED_ENV_NAMES.includes(name) || STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The child environment: the parent minus every stripped name, plus the closed runner-owned control variables.
 * @param {Record<string, string | undefined>} parentEnv
 * @param {{ buildDir?: string, jsonOutput?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildChildEnv(parentEnv, { buildDir, jsonOutput } = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!isStrippedEnvName(name) && !RUNNER_CONTROL_VARIABLES.includes(name) && value !== undefined) env[name] = value;
  }
  env.JAGAON_RELEASE = "1";
  if (buildDir) env.JAGAON_RELEASE_BUILD_DIR = buildDir;
  if (jsonOutput) env.PLAYWRIGHT_JSON_OUTPUT_NAME = jsonOutput;
  return env;
}

/** Parses CLI arguments. Unknown options (including any --env-file) are refused. */
export function parseRunSuiteArgs(argv) {
  const result = { suite: undefined, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") continue;
    if (arg === "--list") result.list = true;
    else if (arg === "--root" || arg === "--build-dir" || arg === "--summary") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: "MISSING_OPTION_VALUE" };
      i += 1;
      if (arg === "--root") result.serveRoot = value;
      else if (arg === "--build-dir") result.buildDir = value;
      else result.summaryPath = value;
    } else if (arg.startsWith("-")) return { error: "UNKNOWN_ARGUMENT" };
    else if (result.suite === undefined) result.suite = arg;
    else return { error: "UNKNOWN_ARGUMENT" };
  }
  if (result.suite === undefined) return { error: "NO_SUITE" };
  return result;
}

function toRelative(root, file) {
  return relative(root, resolve(root, file)).split(sep).join("/");
}

/** Resolves the suite to its groups, refusing before any child process starts. */
export function planSuite(manifest, suite, { root, serveRoot = root, buildDir, exists }) {
  if (!SUITE_NAMES.includes(suite) || manifest?.suites?.[suite] === undefined) return { refusals: [{ code: "UNKNOWN_SUITE", detail: String(suite) }] };
  const entry = manifest.suites[suite];
  const groups = entry.groups;
  const files = groups.flatMap((group) => group.files);
  if (files.length === 0) return { refusals: [{ code: "EMPTY_SUITE", detail: `suite ${suite} has no files (pending task ${entry.pendingTask ?? "none"})` }] };
  const refusals = [];
  for (const group of groups) {
    const base = group.runner === "playwright" ? serveRoot : root;
    for (const file of group.files) if (!exists(join(base, file))) refusals.push({ code: "MISSING_FILE", detail: file });
    if (group.runner === "playwright" && !exists(join(serveRoot, group.config))) refusals.push({ code: "MISSING_FILE", detail: group.config });
  }
  if (entry.requiresBuildDir === true && !buildDir) refusals.push({ code: "BUILD_DIR_REQUIRED", detail: suite });
  return { refusals, groups, files };
}

/** The exact command for one group. Never includes --env-file. */
/**
 * H1 rehearsal: the Vitest worker bound. With the default pool (one worker per core but one) the integration group ran the
 * CPU-bound backup and deletion files (PBKDF2, AES-GCM) beside the jsdom screen files, and passing screen tests timed out at random
 * (2, 4 and 5 different failures on three runs). Four workers ran the same 61 files green in about the same wall time.
 */
export const VITEST_RELEASE_MAX_WORKERS = 4;

export function commandFor(group, { root, serveRoot = root, reportPath }) {
  if (group.runner === "vitest") {
    return {
      cwd: root,
      args: [join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${reportPath}`, "--minWorkers=1", `--maxWorkers=${VITEST_RELEASE_MAX_WORKERS}`, ...group.files],
    };
  }
  return { cwd: serveRoot, args: [join(serveRoot, "node_modules/@playwright/test/cli.js"), "test", "--config", group.config, "--reporter=json", ...group.files] };
}

function emptyCounts() {
  return { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0 };
}

/** Reads a Vitest JSON report into collected files, counts and cases. */
export function readVitestReport(report, { suite, root }) {
  const counts = emptyCounts();
  const collected = [];
  const cases = [];
  const failedFiles = [];
  for (const fileResult of report.testResults ?? []) {
    const file = toRelative(root, fileResult.name);
    collected.push(file);
    const assertions = fileResult.assertionResults ?? [];
    if (fileResult.status === "failed" && !assertions.some((a) => a.status === "failed")) failedFiles.push(file);
    for (const assertion of assertions) {
      counts.tests += 1;
      const status = assertion.status;
      if (status === "passed") counts.passed += 1;
      else if (status === "failed") counts.failed += 1;
      else if (status === "todo") counts.todo += 1;
      else if (status === "pending") counts.pending += 1;
      else counts.skipped += 1;
      cases.push({ suite, file, title: [...(assertion.ancestorTitles ?? []), assertion.title].join(" "), status: status === "passed" || status === "failed" || status === "todo" || status === "pending" ? status : "skipped" });
    }
  }
  counts.files = collected.length;
  return { counts, collected, cases, failedFiles, retries: 0, errors: 0 };
}

/** Reads a Playwright JSON report. A case passes only when every project run of it passed on its first attempt. */
export function readPlaywrightReport(report, { suite, serveRoot }) {
  const counts = emptyCounts();
  const collected = new Set();
  const cases = [];
  let retries = 0;
  const rootDir = report.config?.rootDir ?? serveRoot;
  const visit = (node, file, titles) => {
    for (const spec of node.specs ?? []) {
      const statuses = [];
      for (const test of spec.tests ?? []) {
        counts.tests += 1;
        const results = test.results ?? [];
        if (test.status === "flaky" || results.some((r) => (r.retry ?? 0) > 0)) retries += 1;
        if (test.status === "skipped") counts.skipped += 1;
        else if (test.status === "expected" || test.status === "flaky") counts.passed += 1;
        else counts.failed += 1;
        statuses.push(test.status === "expected" || test.status === "flaky" ? "passed" : test.status === "skipped" ? "skipped" : "failed");
      }
      const status = statuses.length === 0 ? "skipped" : statuses.includes("failed") ? "failed" : statuses.includes("skipped") ? "skipped" : "passed";
      cases.push({ suite, file, title: [...titles, spec.title].join(" "), status });
    }
    for (const child of node.suites ?? []) visit(child, file, [...titles, child.title]);
  };
  // H1 rehearsal: Playwright reports its rootDir as the REAL path (macOS tmpdir /var/… is /private/var/…), so a file is mapped
  // against the serve root as given or, failing that, its real path. A file under neither stays "../…" and is refused as unexpected.
  const roots = [serveRoot, canonicalPath(serveRoot)];
  for (const top of report.suites ?? []) {
    const absolute = join(rootDir, top.file);
    const file = roots.map((r) => toRelative(r, absolute)).find((p) => p !== ".." && !p.startsWith("../")) ?? toRelative(serveRoot, absolute);
    collected.add(file);
    visit(top, file, []);
  }
  counts.files = collected.size;
  return { counts, collected: [...collected], cases, failedFiles: [], retries, errors: (report.errors ?? []).length };
}

/** The refusal reasons for a parsed group result, in a fixed order. */
export function refusalsFor(parsed, expectedFiles, exitCode) {
  const refusals = [];
  const expected = [...new Set(expectedFiles)].sort();
  const collected = [...new Set(parsed.collected)].sort();
  if (parsed.collected.length !== expectedFiles.length) refusals.push({ code: "COLLECTED_COUNT_MISMATCH", detail: `collected ${parsed.collected.length}, manifest ${expectedFiles.length}` });
  if (JSON.stringify(expected) !== JSON.stringify(collected)) {
    const missing = expected.filter((f) => !collected.includes(f));
    const extra = collected.filter((f) => !expected.includes(f));
    refusals.push({ code: "COLLECTED_FILES_MISMATCH", detail: `missing ${missing.length}, unexpected ${extra.length}` });
  }
  if (parsed.counts.passed === 0) refusals.push({ code: "NO_PASSED_TESTS" });
  if (parsed.counts.skipped > 0) refusals.push({ code: "SKIPPED_TESTS", detail: String(parsed.counts.skipped) });
  if (parsed.counts.todo > 0) refusals.push({ code: "TODO_TESTS", detail: String(parsed.counts.todo) });
  if (parsed.counts.pending > 0) refusals.push({ code: "PENDING_TESTS", detail: String(parsed.counts.pending) });
  if (parsed.counts.failed > 0) refusals.push({ code: "FAILED_TESTS", detail: String(parsed.counts.failed) });
  if (parsed.failedFiles.length > 0) refusals.push({ code: "FAILED_FILES", detail: parsed.failedFiles.join(",") });
  if (parsed.retries > 0) refusals.push({ code: "PLAYWRIGHT_RETRY", detail: String(parsed.retries) });
  if (parsed.errors > 0) refusals.push({ code: "REPORT_ERRORS", detail: String(parsed.errors) });
  if (exitCode !== 0) refusals.push({ code: "CHILD_EXIT_NONZERO", detail: String(exitCode) });
  return refusals;
}

function readVersion(ports, path) {
  try {
    return JSON.parse(ports.readFile(path)).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Runs one suite through injected ports and returns its summary. Never throws for a refusal.
 * @param {{ suite: string, root: string, serveRoot?: string, buildDir?: string, manifest: any, env: Record<string, string|undefined>,
 *   ports: { spawn: (command: string, args: string[], options: { cwd: string, env: Record<string, string> }) => Promise<{ exitCode: number }>,
 *   exists: (path: string) => boolean, readFile: (path: string) => string, makeTempDir: () => string, now: () => number } }} input
 */
export async function runSuite({ suite, root, serveRoot = root, buildDir, manifest, env, ports }) {
  const started = ports.now();
  const summary = { suite, ok: false, refusals: [], counts: emptyCounts(), runnerVersions: {}, durationMs: 0, cases: [], groups: [] };
  const plan = planSuite(manifest, suite, { root, serveRoot, buildDir, exists: ports.exists });
  if (plan.refusals.length > 0) {
    summary.refusals = plan.refusals;
    summary.durationMs = ports.now() - started;
    return summary;
  }
  const tempDir = ports.makeTempDir();
  for (const [index, group] of plan.groups.entries()) {
    const reportPath = join(tempDir, `${suite}-${index}-${group.runner}.json`);
    const { cwd, args } = commandFor(group, { root, serveRoot, reportPath });
    const childEnv = buildChildEnv(env, { buildDir, jsonOutput: group.runner === "playwright" ? reportPath : undefined });
    if (group.runner === "vitest") summary.runnerVersions.vitest = readVersion(ports, join(root, "node_modules/vitest/package.json"));
    else summary.runnerVersions.playwright = readVersion(ports, join(serveRoot, "node_modules/@playwright/test/package.json"));
    const { exitCode } = await ports.spawn(process.execPath, args, { cwd, env: childEnv });
    let parsed;
    try {
      const report = JSON.parse(ports.readFile(reportPath));
      parsed = group.runner === "vitest" ? readVitestReport(report, { suite, root }) : readPlaywrightReport(report, { suite, serveRoot });
    } catch {
      summary.refusals.push({ code: "REPORT_UNREADABLE", detail: `${group.runner} group ${index}` });
      summary.groups.push({ runner: group.runner, config: group.config, exitCode, files: group.files.length, refusals: ["REPORT_UNREADABLE"] });
      continue;
    }
    const refusals = refusalsFor(parsed, group.files, exitCode);
    summary.refusals.push(...refusals);
    for (const key of Object.keys(summary.counts)) summary.counts[key] += parsed.counts[key];
    summary.cases.push(...parsed.cases);
    summary.groups.push({ runner: group.runner, config: group.config, exitCode, files: group.files.length, refusals: refusals.map((r) => r.code) });
  }
  summary.ok = summary.refusals.length === 0;
  summary.durationMs = ports.now() - started;
  return summary;
}

/** The real path when it exists (a symlink to the checkout is the checkout), else the resolved path. */
function canonicalPath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Standalone mode only (the orchestrator checks its own export): a served suite needs `--root <clean export>` that is not the
 * checkout and holds no `.env*` file (the committed `.env.example` template excepted). Returns the refusals; empty means proceed.
 */
export function standaloneServeRootRefusals({ suite, root, serveRoot, listEnvFiles }) {
  if (!SERVED_SUITES.includes(suite)) return [];
  if (serveRoot === undefined) return [{ code: "SERVE_ROOT_REQUIRED", detail: `${suite} needs --root <clean export>` }];
  if (canonicalPath(serveRoot) === canonicalPath(root)) return [{ code: "SERVE_ROOT_IS_CHECKOUT", detail: suite }];
  let envFiles;
  try {
    envFiles = listEnvFiles(resolve(serveRoot));
  } catch {
    return [{ code: "SERVE_ROOT_UNREADABLE", detail: suite }];
  }
  return envFiles.length > 0 ? [{ code: "ENV_FILE_IN_SERVE_ROOT", detail: envFiles.join(",") }] : [];
}

/** Every `.env*` file under `dir` except the template `.env.example` (node_modules and .git skipped). */
export function listServeRootEnvFiles(dir) {
  const found = [];
  const walk = (relativeDir) => {
    for (const name of readdirSync(join(dir, relativeDir))) {
      if (name === "node_modules" || name === ".git") continue;
      const path = relativeDir ? `${relativeDir}/${name}` : name;
      if (isEnvSecretFileName(name)) found.push(path);
      else if (statSync(join(dir, path)).isDirectory()) walk(path);
    }
  };
  walk("");
  return found;
}

/** Real ports: node child_process (inherited stdio, no shell), fs and the wall clock. */
export function realRunSuitePorts() {
  return {
    spawn: (command, args, options) =>
      new Promise((resolvePromise) => {
        const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "inherit", "inherit"], shell: false });
        child.on("error", () => resolvePromise({ exitCode: 127 }));
        child.on("close", (code) => resolvePromise({ exitCode: code ?? 1 }));
      }),
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    makeTempDir: () => mkdtempSync(join(tmpdir(), "jagaon-release-suite-")),
    now: () => Date.now(),
  };
}

async function main(argv) {
  const args = parseRunSuiteArgs(argv);
  if (args.error) {
    console.error(`run-suite refused: ${args.error}`);
    return 2;
  }
  const root = process.cwd();
  const serveRoot = args.serveRoot ? resolve(args.serveRoot) : root;
  const manifest = loadSuiteManifest(root);
  const ports = realRunSuitePorts();
  if (args.list) {
    const plan = planSuite(manifest, args.suite, { root, serveRoot, buildDir: args.buildDir ?? "(not required for --list)", exists: ports.exists });
    if (plan.refusals.length > 0) {
      for (const refusal of plan.refusals) console.error(`run-suite refused: ${refusal.code}${refusal.detail ? ` (${refusal.detail})` : ""}`);
      return 1;
    }
    for (const file of plan.files) console.log(file);
    console.log(`${args.suite}: ${plan.files.length} files`);
    return 0;
  }
  const served = standaloneServeRootRefusals({ suite: args.suite, root, serveRoot: args.serveRoot, listEnvFiles: listServeRootEnvFiles });
  if (served.length > 0) {
    for (const refusal of served) console.error(`run-suite refused: ${refusal.code}${refusal.detail ? ` (${refusal.detail})` : ""}`);
    return 1;
  }
  const summary = await runSuite({ suite: args.suite, root, serveRoot, buildDir: args.buildDir ? resolve(args.buildDir) : undefined, manifest, env: process.env, ports });
  const printable = { ...summary, cases: undefined, caseCount: summary.cases.length };
  console.log(JSON.stringify(printable, null, 2));
  if (args.summaryPath) writeFileSync(resolve(args.summaryPath), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  for (const refusal of summary.refusals) console.error(`run-suite refused: ${refusal.code}${refusal.detail ? ` (${refusal.detail})` : ""}`);
  return summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
