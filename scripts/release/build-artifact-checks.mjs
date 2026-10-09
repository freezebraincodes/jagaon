/**
 * Packet 12A B1 (and B8): pure, read-only checks over a Next.js build directory. Nothing here builds, serves or fetches.
 *
 * B1: no shared-contract server-only name or marker under static/; no NEXT_PUBLIC_ name under static/; no secret-shaped value in static
 * output or prerendered HTML; no exact secret value (supplied by the caller, never printed) anywhere in the build (a release run strips
 * every secret from its environment and supplies none, so this check is proved by the synthetic positive control only); no
 * source map under static/; app-path-routes-manifest.json routes equal release/capability-manifest.json routes; no Packet 5A / Safety
 * marker (from the exported src/safety and src/domain/safety identifiers) in static output or HTML; no third-party <script src> host
 * in prerendered HTML; no .env* file. B8 (D4 decided 2026-10-09): configured response headers (routes-manifest.json) equal the exact
 * hackathon policy below: CSP without 'unsafe-eval' or broad sources, frame protection, X-Robots-Tag noindex, Referrer-Policy,
 * Permissions-Policy (microphone self only) and no-store on /api/*. Findings name the check and file only, never a value.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Shared contract with stream 2 (names only). Every JAGAON_* name is a marker too, except the closed client-literal allow-list. */
export const SERVER_MARKERS = Object.freeze(["DEEPSEEK_API_KEY", "KIE_API_KEY", "ONEMAP_ACCESS_TOKEN", "TRTC_SDK_SECRET_KEY", "TRTC_SDK_APP_ID", "tls-sig-api-v2", "TLSSigAPIv2", "TLS.sig"]);
/** In-app code literals that share the JAGAON_ prefix but are not environment names (reviewed 2026-10-09 against src/). */
export const CLIENT_JAGAON_LITERALS = Object.freeze([
  "JAGAON_SYSTEM",
  "JAGAON_PREPARED",
  "JAGAON_USE",
  "JAGAON_BACKUP_HEADER_V1",
  "JAGAON_CANONICAL_JSON_V1",
  "JAGAON_STORES_V1",
  "JAGAON_TABLE_NAMES",
  "JAGAON_DEXIE_VERSION",
  "JAGAON_LEGACY_DEXIE_VERSION",
  "JAGAON_DATABASE_NAME",
  "JAGAON_LOCAL_STATE_KEYS",
  // H1 rehearsal: the canonical-JSON hash profile tags of the deletion and restore planners (domain separation, not env names).
  "JAGAON_DELETION_PLAN_V2",
  "JAGAON_DELETED_COMMAND_HASH_V1",
  "JAGAON_RESTORE_PLAN_V2",
]);
const JAGAON_TOKEN = /JAGAON_[A-Z0-9_]+/g;
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9]{20,}/, /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi;
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|wasm|gz|br)$/i;
const SAFETY_STRING = /HYPOGLYCAEMIA|HEALTHHUB|SCDF|^READING_NOT_/;

function walk(root, relativeDir = "", skip = new Set(["node_modules", "cache"])) {
  const absolute = join(root, relativeDir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((name) => {
    if (skip.has(name)) return [];
    const path = relativeDir ? `${relativeDir}/${name}` : name;
    return statSync(join(root, path)).isDirectory() ? walk(root, path, skip) : [path];
  });
}

function readText(root, path) {
  return BINARY.test(path) ? "" : readFileSync(join(root, path), "utf8");
}

/** Safety markers: exported identifier names plus the distinctive exported string constants of the given modules. */
export function safetyMarkersFrom(modules) {
  const markers = new Set();
  for (const exportsObject of modules) {
    for (const [name, value] of Object.entries(exportsObject)) {
      if (name === "default") continue;
      markers.add(name);
      if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && SAFETY_STRING.test(item)) markers.add(item);
    }
  }
  return [...markers].sort();
}

/** The routes the build must expose: capability-manifest app routes plus framework routes, sorted. */
export function expectedRoutes(root) {
  const manifest = JSON.parse(readFileSync(join(root, "release/capability-manifest.json"), "utf8"));
  return [...manifest.routes.app.map((route) => route.path), ...manifest.routes.framework].sort();
}

/**
 * Runs every B1 check. Read-only.
 * @param {string} buildDir
 * @param {{ expectedRoutes: string[], safetyMarkers: string[], secretValues?: string[] }} options
 * @returns {{ ok: boolean, findings: { check: string, file?: string }[] }}
 */
export function checkBuildArtifacts(buildDir, { expectedRoutes: routes, safetyMarkers, secretValues = [] }) {
  const findings = [];
  const add = (check, file) => {
    if (!findings.some((f) => f.check === check && f.file === file)) findings.push(file === undefined ? { check } : { check, file });
  };
  const all = walk(buildDir);
  const staticFiles = all.filter((path) => path.startsWith("static/"));
  const htmlFiles = all.filter((path) => path.endsWith(".html"));
  const values = secretValues.filter((value) => typeof value === "string" && value.length >= 8);

  for (const path of staticFiles) {
    if (path.endsWith(".map")) add("SOURCE_MAP", path);
    const text = readText(buildDir, path);
    if (SERVER_MARKERS.some((marker) => text.includes(marker)) || [...text.matchAll(JAGAON_TOKEN)].some(([token]) => !CLIENT_JAGAON_LITERALS.includes(token))) {
      add("STATIC_SERVER_MARKER", path);
    }
    if (text.includes("NEXT_PUBLIC_")) add("NEXT_PUBLIC_NAME", path);
  }
  for (const path of [...staticFiles, ...htmlFiles]) {
    const text = readText(buildDir, path);
    if (SECRET_SHAPES.some((shape) => shape.test(text))) add("SECRET_SHAPED_VALUE", path);
    if (safetyMarkers.some((marker) => text.includes(marker))) add("SAFETY_MARKER", path);
  }
  for (const path of htmlFiles) {
    const text = readText(buildDir, path);
    if ([...text.matchAll(SCRIPT_SRC)].length > 0) add("THIRD_PARTY_SCRIPT", path);
  }
  if (values.length > 0) {
    for (const path of all) if (values.some((value) => readText(buildDir, path).includes(value))) add("SECRET_VALUE", path);
  }
  for (const path of walk(buildDir, "", new Set(["node_modules"]))) if (path.split("/").pop().startsWith(".env")) add("ENV_FILE", path);

  const manifestPath = join(buildDir, "app-path-routes-manifest.json");
  if (!existsSync(manifestPath)) add("ROUTE_MANIFEST_MISSING");
  else {
    const built = [...new Set(Object.values(JSON.parse(readFileSync(manifestPath, "utf8"))))].sort();
    if (JSON.stringify(built) !== JSON.stringify([...routes].sort())) add("ROUTE_MISMATCH", "app-path-routes-manifest.json");
  }
  return { ok: findings.length === 0, findings };
}

// --- B8: configured response headers (routes-manifest.json `headers`) ---------------------------------------------------------------

/**
 * TRTC browser signalling hosts, exactly as documented in internal-docs/implementation-plans/13-dependency-and-live-test-preflight.md
 * §1.3 (CSP row, from Tencent's firewall page). The two subdomain wildcards are the documented form; no other wildcard is accepted.
 */
export const TRTC_CONNECT_SOURCES = Object.freeze([
  "https://*.rtc-web.com",
  "wss://*.rtc-web.com",
  "https://*.rtc-web.io",
  "wss://*.rtc-web.io",
  "https://apisgp.my-imcloud.com",
  "wss://apisgp.my-imcloud.com",
]);
const DOCUMENTED_WILDCARD_SOURCES = new Set(TRTC_CONNECT_SOURCES.filter((source) => source.includes("*")));

/** The exact production policy queued for next.config.ts (owner decision D4, 2026-10-09). */
export const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Owner decision 2026-10-09: `data:` for images only (Leaflet's tile-cancellation placeholder); no other directive.
  "img-src 'self' data: https://www.onemap.gov.sg",
  `connect-src 'self' ${TRTC_CONNECT_SOURCES.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Exact expected headers per route class (lower-case keys). */
export const EXPECTED_SECURITY_HEADERS = Object.freeze({
  page: Object.freeze({
    "content-security-policy": EXPECTED_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(self), geolocation=(self), payment=(), usb=()",
    "x-robots-tag": "noindex, nofollow",
  }),
  apiExtra: Object.freeze({ "cache-control": "no-store" }),
});

function headersFor(routesManifest, path) {
  const out = {};
  for (const rule of routesManifest?.headers ?? []) {
    let applies = false;
    try {
      applies = typeof rule.regex === "string" && new RegExp(rule.regex).test(path);
    } catch {
      applies = false;
    }
    if (applies) for (const header of rule.headers ?? []) out[String(header.key).toLowerCase()] = String(header.value);
  }
  return out;
}

function cspDirectives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
}

/** A source is broad when it is `*`, a bare scheme (`https:`, `wss:`, `data:`, `blob:` ...) or an undocumented host wildcard. */
function isBroadSource(source) {
  if (source.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return true;
  return source.includes("*") && !DOCUMENTED_WILDCARD_SOURCES.has(source);
}

/**
 * B8 rule checks on one route's response headers (a plain lower-case header map), usable for configured or live headers.
 * @returns {string[]} check codes
 */
export function securityHeaderFindings(headers, { api = false } = {}) {
  const findings = [];
  const csp = headers["content-security-policy"];
  const directives = csp ? cspDirectives(csp) : {};
  if (!csp) findings.push("CSP_MISSING");
  else {
    const sources = Object.values(directives).flat();
    if (sources.includes("'unsafe-eval'")) findings.push("CSP_UNSAFE_EVAL");
    // Owner decision 2026-10-09: the one exception is `data:` inside img-src; every other directive, scheme or wildcard is broad.
    const broad = Object.entries(directives).some(([name, list]) => list.some((source) => isBroadSource(source) && !(name === "img-src" && source.toLowerCase() === "data:")));
    if (broad) findings.push("CSP_WILDCARD");
    if (!directives["default-src"]) findings.push("CSP_DEFAULT_SRC_MISSING");
  }
  const xfo = (headers["x-frame-options"] ?? "").toUpperCase();
  const frameAncestors = directives["frame-ancestors"];
  if (!(xfo === "DENY" || xfo === "SAMEORIGIN" || (frameAncestors !== undefined && frameAncestors.every((s) => s === "'none'" || s === "'self'")))) findings.push("FRAME_PROTECTION_MISSING");
  if (!/\bnoindex\b/i.test(headers["x-robots-tag"] ?? "")) findings.push("NO_INDEX_MISSING");
  if (!headers["referrer-policy"]) findings.push("REFERRER_POLICY_MISSING");
  const permissions = headers["permissions-policy"] ?? "";
  if (!/\bmicrophone=\((?:self)?\)/.test(permissions)) findings.push("PERMISSIONS_POLICY_MICROPHONE");
  if (api && !/\bno-store\b/i.test(headers["cache-control"] ?? "")) findings.push("API_NO_STORE_MISSING");
  return findings;
}

/**
 * B8 checks on the configured headers (routes-manifest.json) for a page route ("/") and an API route ("/api/ai/shell"). With
 * `exact: true`, every header value must also equal EXPECTED_SECURITY_HEADERS exactly.
 * @returns {{ ok: boolean, findings: { check: string, route: string }[] }}
 */
export function checkSecurityHeaders(routesManifest, { pageRoute = "/", apiRoute = "/api/ai/shell", exact = false } = {}) {
  const findings = [];
  for (const [route, api] of [[pageRoute, false], [apiRoute, true]]) {
    const headers = headersFor(routesManifest, route);
    for (const check of securityHeaderFindings(headers, { api })) findings.push({ check, route });
    if (exact) {
      const expected = { ...EXPECTED_SECURITY_HEADERS.page, ...(api ? EXPECTED_SECURITY_HEADERS.apiExtra : {}) };
      for (const [key, value] of Object.entries(expected)) if (headers[key] !== value) findings.push({ check: `HEADER_MISMATCH:${key}`, route });
    }
  }
  return { ok: findings.length === 0, findings };
}
