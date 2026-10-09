/**
 * Packet 12A A5: traceability registry (release/traceability.json) and its evaluator. Unknown means FAIL.
 *
 * There is no hand-entered disposition. An entry is PASS only when every requirement reference resolves to the exact row or list item
 * whose whitespace-normalised sha256 is pinned, every mapped case was collected and passed in this run (matched by suite, file and full
 * title), every evidence ref resolves inside the evidence bundle, and every non-tooling method (HUMAN_REVIEW, MODEL_EVALUATION,
 * DEVICE_REVIEW, DEPLOYMENT_CHECK) has evidence the tooling did not generate. HACKATHON_DEMO has no NOT_APPLICABLE path (rejected by
 * validateRegistry and FAIL in evaluateEntry); for any other profile NOT_APPLICABLE needs an existing owner decision file;
 * everything else is FAIL with named reasons ("NOT_RUN:..." where the evidence was never produced).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { SUITE_NAMES } from "./suite-manifest.mjs";

export const TRACEABILITY_VERSION = "traceability.12a.1";
export const TRACEABILITY_PATH = "release/traceability.json";
export const METHODS = Object.freeze(["AUTOMATED_TEST", "HUMAN_REVIEW", "MODEL_EVALUATION", "DEVICE_REVIEW", "DEPLOYMENT_CHECK"]);
export const NON_TOOLING_METHODS = Object.freeze(["HUMAN_REVIEW", "MODEL_EVALUATION", "DEVICE_REVIEW", "DEPLOYMENT_CHECK"]);
export const APPLICABILITY = Object.freeze(["APPLICABLE", "NOT_APPLICABLE_PROPOSED"]);
const ENTRY_KEYS = new Set(["id", "requirementRefs", "lrj", "jny", "workflowGroups", "methods", "profiles", "cases", "evidence", "applicability", "naReason", "naDecisionRef"]);
const REF_KEYS = new Set(["requirementId", "documentPath", "sectionAnchor", "invariantFingerprint"]);

export function normaliseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function fingerprint(text) {
  return `sha256:${createHash("sha256").update(normaliseWhitespace(text), "utf8").digest("hex")}`;
}

function headingOf(line) {
  const match = /^(#{1,6})\s+(\S+)/.exec(line);
  return match ? { level: match[1].length, anchor: match[2].replace(/\.$/, "") } : undefined;
}

/**
 * The exact requirement text inside the section whose heading number equals `sectionAnchor` ("2.4", "9.2", "5").
 * `LRJ-nnn`/`JNY-nnn` select the table row that starts with that code; `WG-nn` selects numbered list item nn (continuation lines included).
 */
export function extractRequirementText(markdown, sectionAnchor, requirementId) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => headingOf(line)?.anchor === sectionAnchor);
  if (start === -1) return { error: "ANCHOR_MISSING" };
  const level = headingOf(lines[start]).level;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = headingOf(lines[i]);
    if (heading && heading.level <= level) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);
  const group = /^WG-(\d{1,2})$/.exec(requirementId);
  if (group) {
    const number = String(Number(group[1]));
    const at = section.findIndex((line) => line.startsWith(`${number}. `));
    if (at === -1) return { error: "REQUIREMENT_TEXT_MISSING" };
    const parts = [section[at]];
    for (let i = at + 1; i < section.length && section[i].trim() !== "" && !/^\d+\.\s/.test(section[i]); i += 1) parts.push(section[i]);
    return { text: normaliseWhitespace(parts.join(" ")) };
  }
  const row = section.find((line) => new RegExp(`^\\|\\s*\`${requirementId}[\\s\`]`).test(line));
  return row === undefined ? { error: "REQUIREMENT_TEXT_MISSING" } : { text: normaliseWhitespace(row) };
}

/** Reads a document relative to `root`, or null when absent (docs live in git-ignored internal-docs/, R5). */
export function fsDocReader(root) {
  return (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
}

export function loadRegistry(root, path = TRACEABILITY_PATH) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural validation of the closed registry shape. */
export function validateRegistry(registry) {
  const errors = [];
  if (!isObject(registry) || !Array.isArray(registry.entries)) return { ok: false, errors: ["INVALID_SHAPE"] };
  if (registry.version !== TRACEABILITY_VERSION) errors.push(`UNKNOWN_VERSION:${registry.version}`);
  for (const key of Object.keys(registry)) if (key !== "version" && key !== "entries") errors.push(`UNKNOWN_KEY:registry:${key}`);
  const seen = new Set();
  for (const entry of registry.entries) {
    if (!isObject(entry) || typeof entry.id !== "string") {
      errors.push("INVALID_ENTRY");
      continue;
    }
    const id = entry.id;
    if (seen.has(id)) errors.push(`DUPLICATE_ID:${id}`);
    seen.add(id);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`UNKNOWN_KEY:${id}:${key}`);
    for (const key of ["requirementRefs", "lrj", "jny", "workflowGroups", "methods", "profiles", "cases", "evidence"]) {
      if (!Array.isArray(entry[key])) errors.push(`INVALID_FIELD:${id}:${key}`);
    }
    if (errors.some((error) => error.startsWith(`INVALID_FIELD:${id}:`))) continue;
    if (entry.requirementRefs.length === 0) errors.push(`NO_REQUIREMENT_REF:${id}`);
    for (const ref of entry.requirementRefs) {
      if (!isObject(ref) || Object.keys(ref).some((key) => !REF_KEYS.has(key)) || [...REF_KEYS].some((key) => typeof ref[key] !== "string")) errors.push(`INVALID_REQUIREMENT_REF:${id}`);
    }
    for (const method of entry.methods) if (!METHODS.includes(method)) errors.push(`UNKNOWN_METHOD:${id}:${method}`);
    if (entry.methods.length === 0) errors.push(`NO_METHOD:${id}`);
    if (JSON.stringify(entry.profiles) !== JSON.stringify(["HACKATHON_DEMO"])) errors.push(`INVALID_PROFILES:${id}`);
    if (!APPLICABILITY.includes(entry.applicability)) errors.push(`UNKNOWN_APPLICABILITY:${id}`);
    // P12 fix round: the HACKATHON_DEMO profile has no not-applicable path at all; every requirement is evaluated.
    if (entry.applicability === "NOT_APPLICABLE_PROPOSED" && entry.profiles.includes("HACKATHON_DEMO")) errors.push(`NOT_APPLICABLE_NOT_PERMITTED:${id}`);
    for (const c of entry.cases) {
      if (!isObject(c) || typeof c.suite !== "string" || typeof c.file !== "string" || typeof c.title !== "string" || Object.keys(c).length !== 3) errors.push(`INVALID_CASE:${id}`);
    }
    for (const e of entry.evidence) {
      if (!isObject(e) || !METHODS.includes(e.kind) || typeof e.ref !== "string" || Object.keys(e).length !== 2) errors.push(`INVALID_EVIDENCE:${id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function insideBundle(ref) {
  if (isAbsolute(ref)) return false;
  const normalised = normalize(ref);
  return !normalised.startsWith("..") && !normalised.split(/[\\/]/).includes("..");
}

/**
 * Evaluates one entry.
 * @param {any} entry
 * @param {{ readDoc: (path: string) => string | null, run: { suitesRun: string[], cases: { suite: string, file: string, title: string, status: string }[] },
 *   bundle: { files: string[], toolGenerated: string[] }, decisionExists: (ref: string) => boolean }} ctx
 * @returns {{ id: string, disposition: "PASS" | "FAIL" | "NOT_APPLICABLE", reasons: string[] }}
 */
export function evaluateEntry(entry, ctx) {
  const reasons = [];
  for (const ref of entry.requirementRefs) {
    const doc = ctx.readDoc(ref.documentPath);
    if (doc === null || doc === undefined) {
      reasons.push(`DOC_MISSING:${ref.documentPath}`);
      continue;
    }
    const extracted = extractRequirementText(doc, ref.sectionAnchor, ref.requirementId);
    if (extracted.error) reasons.push(`${extracted.error}:${ref.requirementId}`);
    else if (fingerprint(extracted.text) !== ref.invariantFingerprint) reasons.push(`FINGERPRINT_MISMATCH:${ref.requirementId}`);
  }

  if (entry.applicability === "NOT_APPLICABLE_PROPOSED") {
    // HACKATHON_DEMO: never NOT_APPLICABLE, not even with an owner decision file (validateRegistry also rejects the entry).
    if (Array.isArray(entry.profiles) && entry.profiles.includes("HACKATHON_DEMO")) return { id: entry.id, disposition: "FAIL", reasons: [...reasons, "NOT_APPLICABLE_NOT_PERMITTED:HACKATHON_DEMO"] };
    const decided = typeof entry.naReason === "string" && entry.naReason.length > 0 && typeof entry.naDecisionRef === "string" && ctx.decisionExists(entry.naDecisionRef);
    if (!decided) reasons.push("NA_DECISION_MISSING");
    return { id: entry.id, disposition: reasons.length === 0 ? "NOT_APPLICABLE" : "FAIL", reasons };
  }
  if (entry.applicability !== "APPLICABLE") reasons.push("UNKNOWN_APPLICABILITY");

  if (entry.methods.includes("AUTOMATED_TEST") && entry.cases.length === 0) reasons.push("NOT_RUN:NO_CASES_MAPPED");
  for (const c of entry.cases) {
    if (!SUITE_NAMES.includes(c.suite)) {
      reasons.push(`UNKNOWN_SUITE:${c.suite}`);
      continue;
    }
    if (!ctx.run.suitesRun.includes(c.suite)) {
      reasons.push(`SUITE_NOT_RUN:${c.suite}`);
      continue;
    }
    const inFile = ctx.run.cases.filter((r) => r.suite === c.suite && r.file === c.file);
    if (inFile.length === 0) {
      reasons.push(`FILE_NOT_COLLECTED:${c.file}`);
      continue;
    }
    const match = inFile.filter((r) => r.title === c.title);
    if (match.length === 0) reasons.push(`TITLE_NOT_COLLECTED:${c.file}`);
    else if (match.some((r) => r.status !== "passed")) reasons.push(`CASE_NOT_PASSED:${match.find((r) => r.status !== "passed").status}:${c.file}`);
  }

  const files = new Set(ctx.bundle.files);
  const toolGenerated = new Set(ctx.bundle.toolGenerated);
  for (const method of NON_TOOLING_METHODS) {
    if (!entry.methods.includes(method)) continue;
    const refs = entry.evidence.filter((e) => e.kind === method && insideBundle(e.ref) && files.has(normalize(e.ref)));
    if (refs.length === 0) reasons.push(`NOT_RUN:${method}`);
    else if (refs.every((e) => toolGenerated.has(normalize(e.ref)))) reasons.push(`TOOLING_EVIDENCE_REJECTED:${method}`);
  }
  for (const e of entry.evidence) {
    if (!insideBundle(e.ref)) reasons.push("EVIDENCE_OUTSIDE_BUNDLE");
    else if (!files.has(normalize(e.ref))) reasons.push(`EVIDENCE_MISSING:${e.ref}`);
  }
  return { id: entry.id, disposition: reasons.length === 0 ? "PASS" : "FAIL", reasons: [...new Set(reasons)] };
}

/** Evaluates the whole registry. An invalid registry evaluates nothing and is not ok. */
export function evaluateRegistry(registry, ctx) {
  const validation = validateRegistry(registry);
  const counts = { PASS: 0, FAIL: 0, NOT_APPLICABLE: 0 };
  if (!validation.ok) return { ok: false, errors: validation.errors, entries: [], counts };
  const entries = registry.entries.map((entry) => evaluateEntry(entry, ctx));
  for (const result of entries) counts[result.disposition] += 1;
  return { ok: counts.FAIL === 0, errors: [], entries, counts };
}
