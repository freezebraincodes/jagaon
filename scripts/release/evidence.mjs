/**
 * Packet 12A A7: release evidence writer with allow-list redaction.
 *
 * Writes, under one bundle directory and never elsewhere: `commands/<stage>.json` (per-command results), `environment.json` (versions
 * and OS facts, never environment values), `release-record.json` (design §4.2 / test-release-spec §12.2 fields, closed keys only) and
 * `evidence-index.json` (every artifact with its sha256 and the stage or decision it supports). Every value must match its field's
 * closed pattern or enum, otherwise it is written as "[REDACTED]"; any string containing a secret value from the environment is
 * redacted (values of 8 or more characters); and every string value is scanned again before writing. Prompts, provider payloads, `.env` text, passphrases and email
 * addresses therefore cannot reach the bundle. Files are created exclusively (no overwrite).
 */

import { createHash } from "node:crypto";
import { STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from "./run-suite.mjs";

export const REDACTED = "[REDACTED]";

const SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^packet12-hackathon-\d{8}-[0-9a-f]{7}$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const CODE_WITH_ARGS = /^[A-Z][A-Z0-9_]{0,79}(?::[A-Za-z0-9._/-]{1,160}){0,3}$/;
const REF = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const ROUTE = /^\/[a-z0-9_/-]{0,99}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const STAGE = /^[a-z][a-z0-9-]{0,39}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const SUITES = ["unit", "contract", "integration", "fixtures", "browser", "e2e", "accessibility", "security"];
const COUNT_KEYS = ["files", "tests", "passed", "failed", "skipped", "todo", "pending"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PASSCODE|PASSWORD|PASSPHRASE)/;

const str = (pattern) => ({ kind: "string", pattern });
const list = (pattern) => ({ kind: "list", pattern });
const oneOf = (...values) => ({ kind: "enum", values });
const counts = (keys) => ({ kind: "counts", keys });
const bool = { kind: "boolean" };

/** Closed release-record schema, in output order. */
const RECORD_SCHEMA = {
  releaseId: str(RELEASE_ID),
  profile: oneOf("HACKATHON_DEMO"),
  rehearsal: bool,
  sourceCommit: str(COMMIT),
  sourceTreeClean: bool,
  lockfileDigest: str(SHA),
  buildDigest: { kind: "string", pattern: SHA, also: ["NOT_BUILT"] },
  capabilityManifestVersion: str(VERSION),
  contractSetDigest: { kind: "string", pattern: SHA, also: ["NOT_COMPUTED"] },
  fixtureBundleDigests: list(SHA),
  runtimeBundleVersions: list(VERSION),
  environments: list(VERSION),
  commandResults: list(/^[a-z][a-z0-9-]{0,39}:(?:PASS|FAIL|NOT_RUN)$/),
  discoveredTestCounts: counts(SUITES),
  enabledCapabilities: list(CODE),
  disabledCapabilities: list(CODE),
  routes: list(ROUTE),
  providers: list(/^[A-Z][A-Z_]{0,39}:(?:ON|OFF)$/),
  registryCounts: counts(["PASS", "FAIL", "NOT_APPLICABLE"]),
  blockers: list(CODE_WITH_ARGS),
  humanReviewRefs: list(REF),
  modelEvaluationRefs: list(REF),
  unresolvedDefectRefs: list(REF),
  localCandidateStatus: oneOf("NO_GO", "NOT_EVALUATED"),
  deployedCandidateStatus: oneOf("NOT_DEPLOYED"),
  ownerDecision: oneOf("NONE"),
  decision: oneOf("PASS", "FAIL"),
  decidedAt: str(ISO),
  decisionRefs: list(CODE_WITH_ARGS),
};
export const RELEASE_RECORD_KEYS = Object.freeze(Object.keys(RECORD_SCHEMA));

const ENVIRONMENT_SCHEMA = {
  node: str(SEMVER),
  platform: str(/^[a-z0-9]{1,20}$/),
  arch: str(/^[a-z0-9_]{1,20}$/),
  osRelease: str(/^[0-9][0-9A-Za-z.-]{0,40}$/),
  vitest: str(SEMVER),
  playwright: str(SEMVER),
  next: str(SEMVER),
};
export const ENVIRONMENT_KEYS = Object.freeze(Object.keys(ENVIRONMENT_SCHEMA));

const COMMAND_SCHEMA = {
  stage: str(STAGE),
  status: oneOf("PASS", "FAIL", "NOT_RUN"),
  exitCode: { kind: "int", nullable: true },
  durationMs: { kind: "int" },
  counts: counts(COUNT_KEYS),
  reasons: list(CODE_WITH_ARGS),
};

/**
 * The shortest environment value treated as a secret. Shorter values ("on", "1", "true") are switches, not secrets; scrubbing them
 * would match ordinary words and break the write. Every secret this app reads (keys, passcodes of 8 to 128 characters) is longer.
 */
export const MIN_SECRET_VALUE_LENGTH = 8;

/** Secret values to scrub: every value of a stripped name or prefix family, or a secret-shaped name (≥ MIN_SECRET_VALUE_LENGTH chars). */
export function collectSecretValues(env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (STRIPPED_ENV_NAMES.includes(name) || STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || SECRET_NAME.test(name)) values.add(value);
  }
  return [...values];
}

function cleanString(value, pattern, secrets, also = []) {
  if (typeof value !== "string") return REDACTED;
  if (!also.includes(value) && !pattern.test(value)) return REDACTED;
  if (secrets.some((secret) => value.includes(secret))) return REDACTED;
  return value;
}

function cleanField(rule, value, secrets) {
  switch (rule.kind) {
    case "string":
      return cleanString(value, rule.pattern, secrets, rule.also);
    case "enum":
      return rule.values.includes(value) ? value : REDACTED;
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "int":
      return Number.isInteger(value) && value >= -1024 ? value : rule.nullable ? null : 0;
    case "list":
      return Array.isArray(value) ? value.map((item) => cleanString(item, rule.pattern, secrets)) : [];
    case "counts": {
      const out = {};
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of rule.keys) if (Number.isInteger(value[key]) && value[key] >= 0) out[key] = value[key];
      }
      return out;
    }
    default:
      return REDACTED;
  }
}

function cleanObject(schema, input, secrets) {
  const out = {};
  for (const [key, rule] of Object.entries(schema)) out[key] = cleanField(rule, input?.[key], secrets);
  return out;
}

/** Release record with closed keys. An unknown key is refused (the caller has a bug), not silently written. */
export function sanitiseRecord(record, secrets) {
  for (const key of Object.keys(record)) if (!RELEASE_RECORD_KEYS.includes(key)) throw new Error(`EVIDENCE_UNKNOWN_KEY: ${key}`);
  return cleanObject(RECORD_SCHEMA, record, secrets);
}

/** Every string value (not keys, numbers, booleans or JSON punctuation) in a cleaned value. */
function stringLeaves(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, out);
  return out;
}

/** The final scan runs over the string values only, so a secret can never "match" JSON syntax, a key or a number. */
function serialise(value, secrets) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (stringLeaves(value).some((leaf) => EMAIL.test(leaf) || secrets.some((secret) => leaf.includes(secret)))) throw new Error("EVIDENCE_REDACTION_FAILED");
  return text;
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Writes one evidence bundle through an injected fs port. Returns the written paths relative to `dir`, in write order.
 * @param {{ dir: string, record: Record<string, unknown>, commandResults: Record<string, unknown>[], environment: Record<string, unknown>,
 *   env: Record<string, string | undefined>, fs: { mkdir: (path: string) => void, writeFile: (path: string, text: string) => void } }} input
 */
export function writeEvidenceBundle({ dir, record, commandResults, environment, env, fs }) {
  const secrets = collectSecretValues(env);
  const cleanRecord = sanitiseRecord(record, secrets);
  const outputs = [];
  commandResults.forEach((command, index) => {
    const clean = cleanObject(COMMAND_SCHEMA, command, secrets);
    const name = clean.stage === REDACTED ? `redacted-${index}` : clean.stage;
    outputs.push({ path: `commands/${name}.json`, text: serialise(clean, secrets), supports: [name] });
  });
  const cleanEnvironment = {};
  for (const [key, rule] of Object.entries(ENVIRONMENT_SCHEMA)) {
    const value = cleanField(rule, environment?.[key], secrets);
    cleanEnvironment[key] = value === REDACTED ? "unknown" : value;
  }
  outputs.push({ path: "environment.json", text: serialise(cleanEnvironment, secrets), supports: ["environment"] });
  outputs.push({ path: "release-record.json", text: serialise(cleanRecord, secrets), supports: ["decision"] });

  fs.mkdir(dir);
  if (commandResults.length > 0) fs.mkdir(`${dir}/commands`);
  for (const output of outputs) fs.writeFile(`${dir}/${output.path}`, output.text);
  const index = {
    releaseId: cleanRecord.releaseId,
    artifacts: [...outputs]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((output) => ({ path: output.path, sha256: sha256(output.text), bytes: Buffer.byteLength(output.text, "utf8"), generatedBy: "TOOLING", supports: output.supports })),
  };
  fs.writeFile(`${dir}/evidence-index.json`, serialise(index, secrets));
  return { files: [...outputs.map((output) => output.path), "evidence-index.json"], index };
}
