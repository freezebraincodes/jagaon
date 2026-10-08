/**
 * Packet 11C phase 2 (owner decision option (a), 2026-10-08, offline): the one documented, intentional model-facing request difference.
 *
 * ai-slot-plan.11b.9 changes only the slot planner's remote-eligibility accounting (an application-owned LOCAL field reserves its actual
 * final wording instead of its fixed budget). The slot plan version is part of every model-facing shell request body in exactly two
 * places: the shell input's `slotPlanVersion` (the JSON text of the input message, `input[i].content[j].text`) and the strict output
 * schema's one-value echo enum (`text.format.schema.properties.slotPlanVersion.enum`). So every body differs from its historical
 * (ai-slot-plan.11b.8) body there, and must differ nowhere else.
 *
 * `normaliseSlotPlanVersion` parses the body and the embedded shell-input JSON and rewrites exactly those two version values (current ->
 * historical); nothing else is touched (not another key holding the same string, not the prompt). It refuses a body or an embedded JSON
 * text that does not re-serialise to its exact bytes, so the normalised body is byte-comparable with the historical one. Guards require
 * the occurrence count (2 per body), then byte identity with the historical bodies and digests; `differingPaths` names any other
 * difference.
 */
export const CURRENT_SLOT_PLAN_VERSION = "ai-slot-plan.11b.9";
export const HISTORICAL_SLOT_PLAN_VERSION = "ai-slot-plan.11b.8";
/** The slot-plan version fields of one shell request body (the guard requires exactly these, once each). */
export const SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY = 2;

export type VersionNormalisation = Readonly<{ body: string; occurrences: number; paths: readonly string[] }>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, Json> => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON.parse that refuses any text which would not re-serialise to the identical bytes. */
function parseCanonical(text: string): Json {
  const parsed = JSON.parse(text) as Json;
  if (JSON.stringify(parsed) !== text) throw new Error("VERSION_NORMALISATION_NOT_CANONICAL");
  return parsed;
}

/** An embedded JSON object text (the shell input message), or null for any other string (the prompt). */
function embeddedObject(text: string): Record<string, Json> | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = parseCanonical(text);
    return isObject(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof Error && error.message === "VERSION_NORMALISATION_NOT_CANONICAL") throw error;
    return null;
  }
}

export function normaliseSlotPlanVersion(body: string): VersionNormalisation {
  const root = parseCanonical(body);
  if (!isObject(root)) throw new Error("VERSION_NORMALISATION_NOT_AN_OBJECT");
  const paths: string[] = [];
  // 1. The shell input: the input message JSON's own `slotPlanVersion`.
  const input = root.input;
  if (Array.isArray(input)) {
    input.forEach((message, i) => {
      const content = isObject(message) ? message.content : null;
      if (!Array.isArray(content)) return;
      content.forEach((part, j) => {
        if (!isObject(part) || typeof part.text !== "string") return;
        const shellInput = embeddedObject(part.text);
        if (shellInput === null || !Object.hasOwn(shellInput, "slotPlanVersion") || shellInput.slotPlanVersion !== CURRENT_SLOT_PLAN_VERSION) return;
        shellInput.slotPlanVersion = HISTORICAL_SLOT_PLAN_VERSION;
        part.text = JSON.stringify(shellInput);
        paths.push(`input[${i}].content[${j}].text#slotPlanVersion`);
      });
    });
  }
  // 2. The strict output schema's one-value echo enum for `slotPlanVersion`.
  const format = isObject(root.text) && isObject(root.text.format) ? root.text.format : null;
  const schema = format !== null && isObject(format.schema) ? format.schema : null;
  const echo = schema !== null && isObject(schema.properties) && isObject(schema.properties.slotPlanVersion) ? schema.properties.slotPlanVersion : null;
  if (echo !== null && Array.isArray(echo.enum) && echo.enum.length === 1 && echo.enum[0] === CURRENT_SLOT_PLAN_VERSION) {
    echo.enum = [HISTORICAL_SLOT_PLAN_VERSION];
    paths.push("text.format.schema.properties.slotPlanVersion.enum[0]");
  }
  return Object.freeze({ body: JSON.stringify(root), occurrences: paths.length, paths: Object.freeze(paths) });
}

/**
 * Packet 11C P2b (coordinator ruling, offline, VERSION_NORMALISED_REPLAY; evidence only): the response-side counterpart of
 * `normaliseSlotPlanVersion`, for stored ai-slot-plan.11b.8 responses only and in memory only. It rewrites exactly the model's own
 * `slotPlanVersion` echo inside the one `output_text` of a stored provider envelope, historical -> current, and nothing else: not the
 * envelope's request-parameter echo (`text.format.schema…enum`, which the adapter never reads), not a planted value in a shell, not the
 * prompt. The shell text must be canonical JSON, its JSON string literal must occur exactly once in the raw envelope (so the envelope's
 * other bytes, e.g. a provider's `0.0`, stay exactly as stored), and the result must differ from the original at exactly that one path
 * (`differingPaths`); anything else is refused. Never evidence that a model would echo the current version.
 */
export const RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE = 1;
export type ResponseEchoRewrite = Readonly<{ raw: string; occurrences: number; paths: readonly string[] }>;
export function rewriteStoredResponseEcho(raw: string): ResponseEchoRewrite {
  const envelope = JSON.parse(raw) as Json;
  if (!isObject(envelope) || !Array.isArray(envelope.output)) throw new Error("ECHO_REWRITE_NOT_AN_ENVELOPE");
  const parts: Array<{ path: string; text: string }> = [];
  envelope.output.forEach((item, i) => {
    const content = isObject(item) ? item.content : null;
    if (!Array.isArray(content)) return;
    content.forEach((part, j) => {
      if (isObject(part) && part.type === "output_text" && typeof part.text === "string") parts.push({ path: `output[${i}].content[${j}].text`, text: part.text });
    });
  });
  if (parts.length !== 1) throw new Error("ECHO_REWRITE_OUTPUT_TEXT_COUNT");
  const [{ path, text }] = parts as [{ path: string; text: string }];
  const shell = parseCanonical(text);
  if (!isObject(shell) || shell.slotPlanVersion !== HISTORICAL_SLOT_PLAN_VERSION) throw new Error("ECHO_REWRITE_NOT_HISTORICAL");
  shell.slotPlanVersion = CURRENT_SLOT_PLAN_VERSION;
  const before = JSON.stringify(text);
  if (raw.split(before).length - 1 !== 1) throw new Error("ECHO_REWRITE_NOT_UNIQUE");
  const rewritten = raw.replace(before, () => JSON.stringify(JSON.stringify(shell)));
  const paths = differingPaths(raw, rewritten);
  if (paths.length !== RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE || paths[0] !== `${path}#slotPlanVersion`) throw new Error("ECHO_REWRITE_WIDENED");
  return Object.freeze({ raw: rewritten, occurrences: paths.length, paths: Object.freeze(paths) });
}

/** Every path at which two request bodies differ, descending into embedded JSON object texts (`#` marks the embedded document). */
export function differingPaths(left: string, right: string): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (typeof a === "string" && typeof b === "string") {
      if (a === b) return;
      const [innerA, innerB] = [a, b].map((text) => {
        try {
          return embeddedObject(text);
        } catch {
          return null;
        }
      });
      if (innerA && innerB) walk(innerA, innerB, `${path}#`);
      else out.push(path || "(root)");
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${path}.length`);
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) walk(a[index], b[index], `${path}[${index}]`);
      return;
    }
    if (isObject(a) && isObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const keyOrder = (object: Record<string, unknown>) => Object.keys(object).join("|");
      if (keyOrder(a) !== keyOrder(b) && keys.every((key) => Object.hasOwn(a, key) && Object.hasOwn(b, key))) out.push(`${path}{key order}`);
      for (const key of keys) {
        const next = path === "" || path.endsWith("#") ? `${path}${key}` : `${path}.${key}`;
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) out.push(next);
        else walk(a[key], b[key], next);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path || "(root)");
  };
  walk(JSON.parse(left), JSON.parse(right), "");
  return out;
}
