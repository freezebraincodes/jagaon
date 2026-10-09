#!/usr/bin/env node
/**
 * Packet 12A A6: `npm run test:release -- --profile HACKATHON_DEMO [--rehearsal]`. Wires the real ports into release-core.mjs:
 * read-only git (status, rev-parse, archive of HEAD into a temp export), the A2 suite runner, the filesystem (evidence only), the wall
 * clock and a build port that runs `next build` for the production app, the C7 harness and the Packet 13 voice harness inside the export
 * (no `.env*` except the committed `.env.example` template; the export is removed afterwards; node_modules
 * cloned or linked, telemetry disabled, stripped environment). No network except the local servers the browser suites start.
 * Exit codes are documented in release-core.mjs. With no arguments it refuses NO_PROFILE before any git or runner call.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, platform, release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEnvSecretFileName, runRelease } from "./release-core.mjs";
import { writeEvidenceBundle } from "./evidence.mjs";
import { buildChildEnv, realRunSuitePorts, runSuite } from "./run-suite.mjs";
import { discoverTestFiles, loadSuiteManifest, validateSuiteManifest } from "./suite-manifest.mjs";
import { fsDocReader, loadRegistry } from "./traceability.mjs";

const ROOT = process.cwd();

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function runChild(args, cwd, extraEnv = {}) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...buildChildEnv(process.env), ...extraEnv }, stdio: ["ignore", "inherit", "inherit"], shell: false });
    child.on("error", () => resolvePromise({ exitCode: 127, durationMs: Date.now() - started }));
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, durationMs: Date.now() - started }));
  });
}

const EXPORT_PREFIX = "jagaon-release-export-";

/** Every `.env*` file in the export, except the committed template `.env.example` (variable names only, no values). */
function listEnvFiles(dir) {
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

function readVersion(path) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function hashBuild(buildDir) {
  const hash = createHash("sha256");
  for (const file of ["BUILD_ID", "app-path-routes-manifest.json", "routes-manifest.json"]) {
    const path = join(buildDir, file);
    if (existsSync(path)) hash.update(`${file}\n`).update(readFileSync(path));
  }
  return `sha256:${hash.digest("hex")}`;
}

function linkNodeModules(exportDir) {
  const source = join(ROOT, "node_modules");
  const target = join(exportDir, "node_modules");
  // An APFS clone keeps node_modules inside the export root (Turbopack rejects a symlink that points outside its root); else symlink.
  if (platform() === "darwin" && spawnSync("cp", ["-cR", source, target], { stdio: "ignore" }).status === 0) return "clone";
  symlinkSync(source, target, "dir");
  return "symlink";
}

export function realReleasePorts() {
  const capability = () => JSON.parse(readFileSync(join(ROOT, "release/capability-manifest.json"), "utf8"));
  return {
    git: {
      status: () => git(["status", "--porcelain"]),
      head: () => {
        try {
          return git(["rev-parse", "--verify", "HEAD"]).trim();
        } catch {
          return null;
        }
      },
      archive: (dir) => {
        const tar = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: ROOT, maxBuffer: 2 ** 31 - 1 });
        if (tar.status !== 0) throw new Error("GIT_ARCHIVE_FAILED");
        const extract = spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout, maxBuffer: 2 ** 31 - 1 });
        if (extract.status !== 0) throw new Error("TAR_EXTRACT_FAILED");
        linkNodeModules(dir);
      },
    },
    fs: {
      readFile: (path) => readFileSync(join(ROOT, path), "utf8"),
      exists: (path) => existsSync(join(ROOT, path)),
      listEnvFiles,
      mkdir: (path) => mkdirSync(join(ROOT, path), { recursive: true }),
      writeFile: (path, text) => writeFileSync(join(ROOT, path), text, { flag: "wx" }),
    },
    clock: { now: () => new Date().toISOString() },
    temp: {
      makeDir: () => mkdtempSync(join(tmpdir(), EXPORT_PREFIX)),
      // Only a directory this port made (directly under the OS temp dir, with the export prefix). fs.rm removes a linked node_modules
      // as a link; it never follows it into the checkout.
      remove: (dir) => {
        if (dirname(dir) !== tmpdir() || !basename(dir).startsWith(EXPORT_PREFIX)) throw new Error("NOT_AN_EXPORT_DIR");
        rmSync(dir, { recursive: true, force: true });
      },
    },
    manifests: {
      validate: () => {
        const errors = [];
        const suites = validateSuiteManifest(loadSuiteManifest(ROOT), { discoveredFiles: discoverTestFiles(ROOT) });
        errors.push(...suites.errors.map((error) => `SUITE_MANIFEST:${error.code}`));
        let manifest;
        try {
          manifest = capability();
        } catch {
          return { ok: false, errors: [...errors, "CAPABILITY_MANIFEST_UNREADABLE"] };
        }
        if (manifest.profile !== "HACKATHON_DEMO") errors.push("CAPABILITY_PROFILE_MISMATCH");
        return {
          ok: errors.length === 0,
          errors: [...new Set(errors)],
          capabilityManifestVersion: manifest.version,
          enabledCapabilities: manifest.capabilities.enabled.map((c) => c.id),
          disabledCapabilities: manifest.capabilities.disabled.map((c) => c.id),
          routes: [...manifest.routes.app.map((r) => r.path), ...manifest.routes.framework],
          providers: manifest.providers.map((p) => `${p.id}:${p.state}`),
          runtimeBundleVersions: [manifest.ai.manifestVersion, `intelligence-${manifest.intelligence.manifestVersion}`],
        };
      },
    },
    commands: {
      run: (id) => {
        if (id === "lint") return runChild([join(ROOT, "node_modules/eslint/bin/eslint.js"), "."], ROOT);
        if (id === "typecheck") return runChild([join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", ".", "--incremental", "false"], ROOT);
        return Promise.resolve({ exitCode: 127, durationMs: 0 });
      },
    },
    runner: {
      runSuite: (suite, { buildDir, serveRoot } = {}) =>
        runSuite({ suite, root: ROOT, serveRoot: serveRoot ?? ROOT, buildDir, manifest: loadSuiteManifest(ROOT), env: process.env, ports: realRunSuitePorts() }),
    },
    build: {
      build: async (dir) => {
        const next = join(dir, "node_modules/next/dist/bin/next");
        const env = { NEXT_TELEMETRY_DISABLED: "1" };
        const app = await runChild([next, "build"], dir, env);
        if (app.exitCode !== 0) return { ok: false, reasons: [`NEXT_BUILD_FAILED:${app.exitCode}`] };
        const harness = await runChild([next, "build", "e2e/packet-11c/harness"], dir, env);
        if (harness.exitCode !== 0) return { ok: false, reasons: [`HARNESS_BUILD_FAILED:${harness.exitCode}`] };
        // Packet 13 voice browser evidence (playwright.packet-13.config.ts) serves its own TEST-ONLY harness build.
        const voiceHarness = await runChild([next, "build", "e2e/packet-13/harness"], dir, env);
        if (voiceHarness.exitCode !== 0) return { ok: false, reasons: [`VOICE_HARNESS_BUILD_FAILED:${voiceHarness.exitCode}`] };
        if (listEnvFiles(dir).length > 0) return { ok: false, reasons: ["ENV_FILE_AFTER_BUILD"] };
        return { ok: true, buildDir: join(dir, ".next"), digest: hashBuild(join(dir, ".next")) };
      },
    },
    registry: {
      load: () => loadRegistry(ROOT),
      readDoc: fsDocReader(ROOT),
      decisionExists: (ref) => typeof ref === "string" && !ref.includes("..") && existsSync(join(ROOT, ref)),
    },
    // No mechanism records non-tooling review evidence yet, so nothing resolves a standing blocker and no review file is offered.
    reviews: { resolvedBlockers: () => [], files: () => [] },
    environment: () => ({
      node: process.versions.node,
      platform: platform(),
      arch: arch(),
      osRelease: osRelease(),
      vitest: readVersion("node_modules/vitest/package.json"),
      playwright: readVersion("node_modules/@playwright/test/package.json"),
      next: readVersion("node_modules/next/package.json"),
    }),
    env: process.env,
    writeEvidence: (input) => writeEvidenceBundle(input),
  };
}

async function main(argv) {
  const result = await runRelease(argv, realReleasePorts());
  if (result.refusal) {
    console.error(`test:release refused: ${result.refusal} (exit ${result.exitCode})`);
    return result.exitCode;
  }
  for (const stage of result.stages) console.log(`${stage.id.padEnd(14)} ${stage.status}${stage.reasons.length ? `  ${stage.reasons.join(", ")}` : ""}`);
  console.log(`registry       PASS ${result.registry.counts.PASS} / FAIL ${result.registry.counts.FAIL} / NOT_APPLICABLE ${result.registry.counts.NOT_APPLICABLE}`);
  console.log(`decision       ${result.decision} (${result.releaseId}); evidence ${result.evidenceDir}`);
  for (const ref of result.decisionRefs) console.log(`  - ${ref}`);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
