/**
 * Packet 12A A6: release orchestrator decision logic, behind injected ports (git, fs, clock, temp, manifests, commands, runner, build,
 * registry, reviews, environment, evidence writer). release.mjs wires the real ports; tests use fakes only.
 *
 * Refusals happen before any stage, each with its own exit code: NO_PROFILE 2, UNKNOWN_PROFILE 3, DIRTY_TREE 4, UNKNOWN_COMMIT 5,
 * LOCKFILE_UNREADABLE 6, EVIDENCE_EXISTS 7 (never overwrite), ENV_FILE_IN_BUILD 8 (the export of HEAD is made and checked before any stage),
 * UNKNOWN_ARGUMENT 9. Decision FAIL exits 1, PASS exits 0. Stages follow test-release-spec §12.1; a failed stage stops its dependants
 * and is recorded. `--rehearsal` runs every stage on a dirty tree, writes only under test-results/release-rehearsal/<timestamp>/ and
 * always decides FAIL (REHEARSAL_NOT_RELEASE_EVIDENCE). The standing blockers below are listed on every run until real, non-tooling
 * evidence resolves them; the tooling itself can never resolve them. A PASS decision is never a local GO: GO is the owner's.
 */

import { createHash } from "node:crypto";
import { evaluateRegistry, validateRegistry } from "./traceability.mjs";

export const PROFILE = "HACKATHON_DEMO";
export const EXIT_CODES = Object.freeze({
  PASS: 0,
  FAIL: 1,
  NO_PROFILE: 2,
  UNKNOWN_PROFILE: 3,
  DIRTY_TREE: 4,
  UNKNOWN_COMMIT: 5,
  LOCKFILE_UNREADABLE: 6,
  EVIDENCE_EXISTS: 7,
  ENV_FILE_IN_BUILD: 8,
  UNKNOWN_ARGUMENT: 9,
});

/** Stage graph in execution order (test-release-spec §12.1). Evidence refs and evaluation always follow. */
export const STAGES = Object.freeze([
  { id: "source", deps: [] },
  { id: "registry", deps: ["source"] },
  { id: "lint", deps: ["source"] },
  { id: "typecheck", deps: ["source"] },
  { id: "unit", deps: ["typecheck"] },
  { id: "contract", deps: ["typecheck"] },
  { id: "fixtures", deps: ["typecheck"] },
  { id: "integration", deps: ["unit", "contract", "fixtures"] },
  { id: "build", deps: ["lint", "typecheck"] },
  { id: "browser", deps: ["build"] },
  { id: "e2e", deps: ["build"] },
  { id: "accessibility", deps: ["build"] },
  { id: "security", deps: ["build"] },
]);
const PRE_BUILD_SUITES = ["unit", "contract", "fixtures", "integration"];
const BUILD_SUITES = ["browser", "e2e", "accessibility", "security"];

/** Release blockers that only real, non-tooling evidence can close (plan §7.2; brief A6). Never PASS or NOT_APPLICABLE here. */
export const STANDING_BLOCKERS = Object.freeze([
  { code: "PACKET_11C_ACCEPTED_COMMITTED_PUSHED", ref: "R4/D1", status: "FAIL", detail: "Packet 11C acceptance, commit and push are not recorded; the early-work exception is not acceptance." },
  { code: "D2_REMOTE_AI_RULING_AND_MODEL_EVALUATION", ref: "R7/D2", status: "FAIL", detail: "No owner ruling on public remote AI and no reviewed model-evaluation record; all request classes PENDING." },
  { code: "HUMAN_BILINGUAL_REVIEW", ref: "plan 7.2", status: "FAIL", detail: "No human bilingual (en-SG/zh-SG) copy or LRJ-009 screenshot/mockup review is recorded." },
  { code: "HUMAN_ACCESSIBILITY_REVIEW", ref: "plan 7.2/R13", status: "FAIL", detail: "No human keyboard or screen-reader review is recorded." },
  { code: "HUMAN_SECURITY_REVIEW", ref: "plan 7.2", status: "FAIL", detail: "No human security review is recorded." },
  { code: "PHYSICAL_DEVICE_MATRIX", ref: "design 6.1", status: "FAIL", detail: "MacBook Chrome, iPhone Safari and Android Chrome physical-device review: NOT RUN." },
  {
    code: "DEPENDENCY_ADVISORY_REVIEW",
    ref: "design 7",
    status: "FAIL",
    detail: "npm audit on the current tree (coordinator observation, 2026-10-09): 19 advisories (3 critical, 11 high, 5 moderate), all from pre-existing dependencies; unresolved. This is FAIL, not 'not checked'.",
  },
  { code: "DEPLOYMENT_AND_DEPLOYED_SMOKE", ref: "design 11.2", status: "FAIL", detail: "No Vercel deployment, revision match, deployed headers check or deployed smoke: NOT RUN." },
  { code: "OWNER_GO", ref: "design 11.1", status: "FAIL", detail: "No owner GO decision is recorded; tooling never records GO." },
]);

/** Test files whose failing cases map to a named blocker. */
export const CASE_FILE_BLOCKERS = Object.freeze({
  "tests/release/headers.test.ts": "SECURITY_HEADERS",
  "e2e/packet-12/critical-journey.spec.ts": "CRITICAL_JOURNEY",
  "tests/release/build-artifact.test.ts": "BUILD_ARTIFACT_CHECKS",
});

/** Committed `.env*` templates that hold variable names only (no values); every other `.env*` name refuses the build. */
export const ENV_TEMPLATE_FILE_NAMES = Object.freeze([".env.example"]);

/** True for a `.env*` file name that must never be in the export or the build (exact template names are exempt). */
export function isEnvSecretFileName(name) {
  return typeof name === "string" && name.startsWith(".env") && !ENV_TEMPLATE_FILE_NAMES.includes(name);
}

export function parseReleaseArgs(argv) {
  const parsed = { profile: undefined, rehearsal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rehearsal") parsed.rehearsal = true;
    else if (arg === "--profile") {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        parsed.profile = value;
        i += 1;
      }
    } else if (arg.startsWith("--profile=")) parsed.profile = arg.slice("--profile=".length) || undefined;
    else return { error: "UNKNOWN_ARGUMENT" };
  }
  return parsed;
}

/**
 * The release ID: `packet12-hackathon-<YYYYMMDD>-<commit7>`. The date is the UTC calendar date of the clock's ISO-8601 instant
 * (`Date#toISOString`, always UTC), not the local Singapore date: a run at 07:30 SGT on 10 October is dated 20261009.
 */
export function releaseIdFor(nowIso, commit) {
  return `packet12-hackathon-${nowIso.slice(0, 10).replace(/-/g, "")}-${commit.slice(0, 7)}`;
}

export function rehearsalStamp(nowIso) {
  return nowIso.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function refuse(code) {
  return { exitCode: EXIT_CODES[code], refusal: code, decision: "FAIL", stages: [] };
}

function stageResult(id, status, reasons = [], extra = {}) {
  return { id, status, reasons, exitCode: extra.exitCode ?? null, durationMs: extra.durationMs ?? 0, counts: extra.counts ?? {} };
}

/**
 * Runs the release (or rehearsal) through the ports and returns the outcome. Never writes outside the evidence directory.
 * @returns {Promise<{ exitCode: number, refusal?: string, decision: "PASS" | "FAIL", stages: any[], releaseId?: string, evidenceDir?: string,
 *   decisionRefs?: string[], registry?: any }>}
 */
export async function runRelease(argv, ports) {
  const args = parseReleaseArgs(argv);
  if (args.error) return refuse(args.error);
  if (args.profile === undefined) return refuse("NO_PROFILE");
  if (args.profile !== PROFILE) return refuse("UNKNOWN_PROFILE");

  const status = ports.git.status();
  const treeClean = status.trim() === "";
  if (!treeClean && !args.rehearsal) return refuse("DIRTY_TREE");
  const commit = ports.git.head();
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return refuse("UNKNOWN_COMMIT");
  let lockfileDigest;
  try {
    lockfileDigest = `sha256:${createHash("sha256").update(ports.fs.readFile("package-lock.json"), "utf8").digest("hex")}`;
  } catch {
    return refuse("LOCKFILE_UNREADABLE");
  }
  const now = ports.clock.now();
  const releaseId = releaseIdFor(now, commit);
  const evidenceDir = args.rehearsal ? `test-results/release-rehearsal/${rehearsalStamp(now)}` : `internal-docs/release-evidence/packet-12/${releaseId}`;
  if (ports.fs.exists(evidenceDir)) return refuse("EVIDENCE_EXISTS");

  // The export of HEAD and its `.env*` check come first, before any stage: a `.env*` file refuses at once (exit 8). An export that
  // throws is not a refusal: the build stage records FAIL (EXPORT_FAILED) and its dependants are NOT_RUN. The export directory is
  // always removed at the end (best effort).
  let exportDir;
  let exportError = null;
  try {
    exportDir = ports.temp.makeDir();
    ports.git.archive(exportDir);
    if (ports.fs.listEnvFiles(exportDir).length > 0) {
      removeExport(ports, exportDir);
      return refuse("ENV_FILE_IN_BUILD");
    }
  } catch {
    exportError = "EXPORT_FAILED";
  }
  try {
    return await runStages({ args, ports, treeClean, commit, lockfileDigest, now, releaseId, evidenceDir, exportDir, exportError });
  } finally {
    removeExport(ports, exportDir);
  }
}

function removeExport(ports, dir) {
  if (dir === undefined) return;
  try {
    ports.temp.remove(dir);
  } catch {
    // Best effort: a leftover temporary export never changes the decision.
  }
}

async function runStages({ args, ports, treeClean, commit, lockfileDigest, now, releaseId, evidenceDir, exportDir, exportError }) {
  const results = new Map();
  const summaries = new Map();
  let manifestFacts = { capabilityManifestVersion: "unknown", enabledCapabilities: [], disabledCapabilities: [], routes: [], providers: [] };
  let build = { ok: false };
  const blocked = (stage) => stage.deps.find((dep) => results.get(dep)?.status !== "PASS");

  for (const stage of STAGES) {
    const failedDep = blocked(stage);
    if (failedDep !== undefined) {
      results.set(stage.id, stageResult(stage.id, "NOT_RUN", [`DEPENDENCY_FAILED:${failedDep}`]));
      continue;
    }
    if (stage.id === "source") {
      const validation = ports.manifests.validate();
      manifestFacts = { ...manifestFacts, ...validation };
      results.set("source", stageResult("source", validation.ok ? "PASS" : "FAIL", validation.ok ? [] : validation.errors.map(String)));
    } else if (stage.id === "registry") {
      const validation = validateRegistry(ports.registry.load());
      results.set("registry", stageResult("registry", validation.ok ? "PASS" : "FAIL", validation.errors));
    } else if (stage.id === "lint" || stage.id === "typecheck") {
      const { exitCode, durationMs } = await ports.commands.run(stage.id);
      results.set(stage.id, stageResult(stage.id, exitCode === 0 ? "PASS" : "FAIL", exitCode === 0 ? [] : [`EXIT_CODE:${exitCode}`], { exitCode, durationMs }));
    } else if (PRE_BUILD_SUITES.includes(stage.id) || BUILD_SUITES.includes(stage.id)) {
      const options = BUILD_SUITES.includes(stage.id) ? { buildDir: build.buildDir, serveRoot: exportDir } : {};
      const summary = await ports.runner.runSuite(stage.id, options);
      summaries.set(stage.id, summary);
      results.set(stage.id, stageResult(stage.id, summary.ok ? "PASS" : "FAIL", summary.refusals.map((r) => r.code), { counts: summary.counts, durationMs: summary.durationMs ?? 0 }));
    } else if (stage.id === "build") {
      if (exportError !== null || exportDir === undefined) {
        results.set("build", stageResult("build", "FAIL", [exportError ?? "EXPORT_FAILED"]));
        continue;
      }
      try {
        build = (await ports.build.build(exportDir)) ?? { ok: false, reasons: ["BUILD_FAILED"] };
      } catch {
        build = { ok: false, reasons: ["BUILD_THREW"] };
      }
      results.set("build", stageResult("build", build.ok ? "PASS" : "FAIL", build.ok ? [] : build.reasons ?? ["BUILD_FAILED"]));
    }
  }
  const stages = STAGES.map((stage) => results.get(stage.id));

  // Evidence refs and evaluation.
  const cases = [...summaries.values()].flatMap((summary) => summary.cases ?? []);
  const toolFiles = [...stages.map((stage) => `commands/${stage.id}.json`), "environment.json", "release-record.json", "evidence-index.json"];
  const registry = evaluateRegistry(ports.registry.load(), {
    readDoc: ports.registry.readDoc,
    decisionExists: ports.registry.decisionExists,
    run: { suitesRun: [...summaries.keys()], cases },
    bundle: { files: [...ports.reviews.files(), ...toolFiles], toolGenerated: toolFiles },
  });
  const caseBlockers = Object.entries(CASE_FILE_BLOCKERS)
    .filter(([file]) => cases.some((c) => c.file === file && c.status !== "passed"))
    .map(([, code]) => code);
  const resolved = new Set(ports.reviews.resolvedBlockers());
  const standing = STANDING_BLOCKERS.filter((blocker) => !resolved.has(blocker.code)).map((blocker) => blocker.code);

  const decisionRefs = [];
  if (args.rehearsal) decisionRefs.push("REHEARSAL_NOT_RELEASE_EVIDENCE");
  if (!treeClean) decisionRefs.push("SOURCE_TREE_DIRTY");
  for (const stage of stages) if (stage.status !== "PASS") decisionRefs.push(`${stage.status === "FAIL" ? "STAGE_FAILED" : "STAGE_NOT_RUN"}:${stage.id}`);
  if (!registry.ok && registry.errors.length > 0) decisionRefs.push("REGISTRY_INVALID");
  for (const entry of registry.entries) if (entry.disposition === "FAIL") decisionRefs.push(`REGISTRY_FAIL:${entry.id}`);
  for (const code of [...caseBlockers, ...standing]) decisionRefs.push(`BLOCKER:${code}`);
  const decision = decisionRefs.length === 0 ? "PASS" : "FAIL";

  const environment = ports.environment();
  const record = {
    releaseId,
    profile: PROFILE,
    rehearsal: args.rehearsal,
    sourceCommit: commit,
    sourceTreeClean: treeClean,
    lockfileDigest,
    buildDigest: build.ok && build.digest ? build.digest : "NOT_BUILT",
    capabilityManifestVersion: manifestFacts.capabilityManifestVersion,
    contractSetDigest: "NOT_COMPUTED",
    fixtureBundleDigests: [],
    runtimeBundleVersions: manifestFacts.runtimeBundleVersions ?? [],
    environments: [`node-${environment.node}-${environment.platform}-${environment.arch}`.toLowerCase()],
    commandResults: stages.map((stage) => `${stage.id}:${stage.status}`),
    discoveredTestCounts: Object.fromEntries([...summaries.entries()].map(([suite, summary]) => [suite, summary.counts?.tests ?? 0])),
    enabledCapabilities: manifestFacts.enabledCapabilities,
    disabledCapabilities: manifestFacts.disabledCapabilities,
    routes: manifestFacts.routes,
    providers: manifestFacts.providers,
    registryCounts: registry.counts,
    blockers: [...caseBlockers, ...standing],
    humanReviewRefs: [],
    modelEvaluationRefs: [],
    unresolvedDefectRefs: [],
    localCandidateStatus: decision === "PASS" ? "NOT_EVALUATED" : "NO_GO",
    deployedCandidateStatus: "NOT_DEPLOYED",
    ownerDecision: "NONE",
    decision,
    decidedAt: now,
    decisionRefs,
  };
  const commandResults = stages.map((stage) => ({ stage: stage.id, status: stage.status, exitCode: stage.exitCode, durationMs: stage.durationMs, counts: stage.counts, reasons: stage.reasons }));
  let evidenceFiles = [];
  try {
    evidenceFiles = ports.writeEvidence({ dir: evidenceDir, record, commandResults, environment, env: ports.env, fs: ports.fs }).files;
  } catch (error) {
    decisionRefs.push("EVIDENCE_WRITE_FAILED");
    return { exitCode: EXIT_CODES.FAIL, decision: "FAIL", stages, releaseId, evidenceDir, decisionRefs, registry, evidenceError: String(error?.message ?? error) };
  }
  return { exitCode: decision === "PASS" ? EXIT_CODES.PASS : EXIT_CODES.FAIL, decision, stages, releaseId, evidenceDir, decisionRefs, registry, evidenceFiles, blockers: record.blockers };
}
