/**
 * Packet 12A A1: closed release suite manifest (release/suite-manifest.json).
 *
 * Every `src/**\/*.test.{ts,tsx}`, `tests/**\/*.test.{ts,tsx}` and `e2e/**\/*.spec.ts` file appears exactly once: in one suite group or
 * in `excluded` (LIVE_PROVIDER or LOCAL_ARTIFACT_REPLAY, each with a reason). A suite with no files must name the task that will fill
 * it (`pendingTask`); the release runner still refuses it as EMPTY_SUITE. Pure functions plus two small fs helpers; no child process.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUITE_MANIFEST_VERSION = "release-suites.12a.1";
export const SUITE_MANIFEST_PATH = "release/suite-manifest.json";
export const SUITE_NAMES = Object.freeze(["unit", "contract", "integration", "fixtures", "browser", "e2e", "accessibility", "security"]);
export const RUNNERS = Object.freeze(["vitest", "playwright"]);
export const EXCLUSION_CATEGORIES = Object.freeze(["LIVE_PROVIDER", "LOCAL_ARTIFACT_REPLAY"]);

const VITEST_FILE = /^(?:src|tests)\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/;
const PLAYWRIGHT_FILE = /^e2e\/(?:[^/]+\/)*[^/]+\.spec\.ts$/;
const TOP_KEYS = new Set(["version", "suites", "excluded"]);
const SUITE_KEYS = new Set(["groups", "pendingTask", "requiresBuildDir"]);
const GROUP_KEYS = new Set(["runner", "config", "files"]);
const EXCLUSION_KEYS = new Set(["file", "category", "reason"]);
const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git"]);

/** True when `file` is a test path under the closed globs. */
export function isTestPath(file) {
  return VITEST_FILE.test(file) || PLAYWRIGHT_FILE.test(file);
}

/** Every test file under the closed globs, repo-relative with `/` separators, sorted. Skips node_modules, .next and .git. */
export function discoverTestFiles(root) {
  const found = [];
  const walk = (relativeDir) => {
    const absolute = join(root, relativeDir);
    if (!existsSync(absolute)) return;
    for (const name of readdirSync(absolute)) {
      if (SKIPPED_DIRS.has(name)) continue;
      const path = `${relativeDir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (isTestPath(path)) found.push(path);
    }
  };
  for (const dir of ["src", "tests", "e2e"]) walk(dir);
  return found.sort();
}

export function loadSuiteManifest(root, path = SUITE_MANIFEST_PATH) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

/**
 * Validates `manifest` against the closed shape and the discovered file list.
 * @param {unknown} manifest
 * @param {{ discoveredFiles: string[], fileExists?: (file: string) => boolean }} options
 * @returns {{ ok: boolean, errors: { code: string, suite?: string, file?: string, detail?: string }[] }}
 */
export function validateSuiteManifest(manifest, { discoveredFiles, fileExists }) {
  const errors = [];
  const exists = fileExists ?? ((file) => discoveredFiles.includes(file));
  if (!isObject(manifest) || !isObject(manifest.suites) || !Array.isArray(manifest.excluded)) {
    return { ok: false, errors: [{ code: "INVALID_SHAPE" }] };
  }
  for (const key of unknownKeys(manifest, TOP_KEYS)) errors.push({ code: "UNKNOWN_KEY", detail: key });
  if (manifest.version !== SUITE_MANIFEST_VERSION) errors.push({ code: "UNKNOWN_VERSION", detail: String(manifest.version) });

  const seen = new Map();
  const note = (file, where) => {
    if (seen.has(file)) errors.push({ code: "DUPLICATE_FILE", file, detail: `${seen.get(file)} and ${where}` });
    else seen.set(file, where);
  };
  const checkFile = (file, suite) => {
    if (typeof file !== "string" || !isTestPath(file)) errors.push({ code: "UNKNOWN_FILE", suite, file: String(file) });
    else if (!exists(file)) errors.push({ code: "MISSING_FILE", suite, file });
  };

  for (const suite of Object.keys(manifest.suites)) {
    if (!SUITE_NAMES.includes(suite)) errors.push({ code: "UNKNOWN_SUITE", suite });
  }
  for (const suite of SUITE_NAMES) {
    const entry = manifest.suites[suite];
    if (entry === undefined) {
      errors.push({ code: "MISSING_SUITE", suite });
      continue;
    }
    if (!isObject(entry) || !Array.isArray(entry.groups)) {
      errors.push({ code: "INVALID_SHAPE", suite });
      continue;
    }
    for (const key of unknownKeys(entry, SUITE_KEYS)) errors.push({ code: "UNKNOWN_KEY", suite, detail: key });
    let count = 0;
    for (const group of entry.groups) {
      if (!isObject(group) || !Array.isArray(group.files)) {
        errors.push({ code: "INVALID_SHAPE", suite });
        continue;
      }
      for (const key of unknownKeys(group, GROUP_KEYS)) errors.push({ code: "UNKNOWN_KEY", suite, detail: key });
      if (!RUNNERS.includes(group.runner)) errors.push({ code: "UNKNOWN_RUNNER", suite, detail: String(group.runner) });
      if (group.runner === "playwright" && (typeof group.config !== "string" || group.config.length === 0)) {
        errors.push({ code: "PLAYWRIGHT_CONFIG_REQUIRED", suite });
      }
      for (const file of group.files) {
        count += 1;
        note(file, `suite ${suite}`);
        checkFile(file, suite);
        if (typeof file === "string" && RUNNERS.includes(group.runner)) {
          const ok = group.runner === "vitest" ? VITEST_FILE.test(file) : PLAYWRIGHT_FILE.test(file);
          if (!ok && isTestPath(file)) errors.push({ code: "RUNNER_FILE_MISMATCH", suite, file });
        }
      }
    }
    if (count === 0 && (typeof entry.pendingTask !== "string" || entry.pendingTask.length === 0)) {
      errors.push({ code: "EMPTY_SUITE_WITHOUT_PENDING_TASK", suite });
    }
  }

  for (const exclusion of manifest.excluded) {
    if (!isObject(exclusion)) {
      errors.push({ code: "INVALID_SHAPE", detail: "excluded" });
      continue;
    }
    for (const key of unknownKeys(exclusion, EXCLUSION_KEYS)) errors.push({ code: "UNKNOWN_KEY", detail: key });
    if (!EXCLUSION_CATEGORIES.includes(exclusion.category)) errors.push({ code: "UNKNOWN_CATEGORY", file: exclusion.file, detail: String(exclusion.category) });
    if (typeof exclusion.reason !== "string" || exclusion.reason.trim().length === 0) errors.push({ code: "EXCLUSION_REASON_REQUIRED", file: exclusion.file });
    if (seen.has(exclusion.file) && seen.get(exclusion.file).startsWith("suite ")) {
      errors.push({ code: "EXCLUDED_AND_LISTED", file: exclusion.file, detail: seen.get(exclusion.file) });
    } else {
      note(exclusion.file, "excluded");
    }
    checkFile(exclusion.file, undefined);
  }

  for (const file of discoveredFiles) {
    if (!seen.has(file)) errors.push({ code: "UNLISTED_FILE", file });
  }
  return { ok: errors.length === 0, errors };
}

/** The suite's groups, refusing an unknown suite name. */
export function suiteGroups(manifest, suite) {
  if (!SUITE_NAMES.includes(suite) || !isObject(manifest.suites[suite])) throw new Error(`UNKNOWN_SUITE: ${suite}`);
  return manifest.suites[suite].groups;
}

/** Every file of a suite, in manifest order. */
export function manifestFiles(manifest, suite) {
  return suiteGroups(manifest, suite).flatMap((group) => group.files);
}
