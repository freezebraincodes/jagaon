// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Packet 13 slice (P13S, S5/S7): the voice stream's own import and secret boundaries. (Folding these rules into the shared
 * import-boundary suite is the coordinator's optional Q13-3.)
 */
const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir)).flatMap((name) => {
        const path = `${dir}/${name}`;
        return statSync(join(ROOT, path)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
      })
    : [];
const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const SPECIFIER = /(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const imports = (file: string) => [...read(file).matchAll(SPECIFIER)].map((match) => ({ typeOnly: Boolean(match[1]), dynamic: match[3] !== undefined, specifier: (match[2] ?? match[3])! }));

function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => join(ROOT, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = (match[2] ?? match[3])!;
      const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!base) continue;
      const target = (extname(base) ? [base] : [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => `${base}${suffix}`)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target) pending.push(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
}

const DOMAIN_APPLICATION = [...walk("src/domain/voice"), ...walk("src/application/voice")];
const PROVIDER = walk("src/voice");
const SERVER = walk("src/app/api/voice");
const VOICE_SOURCES = [...DOMAIN_APPLICATION, ...PROVIDER, ...SERVER, "src/types/tls-sig-api-v2.d.ts"].filter((file) => existsSync(join(ROOT, file)) && !isTest(file));
const NETWORK = /(?<![.\w$])fetch\b(?!\s*:)|(?:globalThis|window|self)\s*\.\s*fetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;
const SIGNER = "src/app/api/voice/usersig/voice-usersig-signer.ts";
const ROUTE = "src/app/api/voice/usersig/route.ts";
/** Web Speech (owner-approved scope 2026-10-11, W-3): the passcode-only access route, the voice stream's second environment read. */
const ACCESS_ROUTE = "src/app/api/voice/access/route.ts";
const CREDENTIAL_CLIENT = "src/voice/trtc/trtc-credential-client.ts";
const CONFIG = "src/app/api/voice/usersig/voice-usersig-config.ts";

describe("voice import boundary", () => {
  it("finds the stream's files (the scan is not vacuous)", () => {
    expect(DOMAIN_APPLICATION.length).toBeGreaterThanOrEqual(10);
    expect(PROVIDER).toEqual(expect.arrayContaining(["src/voice/trtc/trtc-transcriber-adapter.ts", "src/voice/trtc/trtc-sdk-surface.ts", "src/voice/trtc/trtc-usersig-contract.ts"]));
    expect(SERVER).toEqual(expect.arrayContaining(["src/app/api/voice/usersig/voice-usersig-handler.ts", CONFIG]));
  });

  it("keeps domain and application voice code free of TRTC, signing, server, AI, storage, React and Dexie", () => {
    const forbidden = /^(trtc-sdk-v5|tls-sig-api-v2|react|react-dom|dexie)(\/|$)|^@\/(voice|app|ai|storage|backup|components)\/|^next(\/|$)/;
    for (const file of DOMAIN_APPLICATION) {
      for (const { specifier } of imports(file)) {
        if (isTest(file) && /^node:|^vitest$/.test(specifier)) continue;
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(forbidden);
        // Product sources of the voice domain import only their siblings and zod (a test file may hold regex text that looks like an import).
        if (file.startsWith("src/domain/voice/") && !isTest(file)) expect(specifier, `${file} imports ${specifier}`).toMatch(/^(\.\/|zod$)/);
      }
      if (isTest(file)) continue;
      const code = strip(read(file));
      expect(code, file).not.toMatch(NETWORK);
      expect(code, file).not.toMatch(/process\.env|import\.meta\.env|localStorage|sessionStorage|indexedDB/);
    }
  });

  it("never statically imports the TRTC SDK value and never imports the signing library outside the signer", () => {
    for (const file of PROVIDER.filter((path) => !isTest(path))) {
      for (const { specifier, typeOnly, dynamic } of imports(file)) {
        if (/^trtc-sdk-v5(\/|$)/.test(specifier)) expect(typeOnly || dynamic, `${file}: static value import of ${specifier}`).toBe(true);
        expect(specifier, file).not.toMatch(/^tls-sig-api-v2/);
      }
    }
    const signerImporters = walk("src").filter((file) => imports(file).some(({ specifier }) => specifier === "tls-sig-api-v2"));
    expect(signerImporters.filter((file) => !isTest(file))).toEqual(existsSync(join(ROOT, SIGNER)) ? [SIGNER] : []);
    expect(walk("src").filter((file) => !isTest(file) && imports(file).some(({ specifier }) => /^trtc-sdk-v5/.test(specifier))).sort()).toEqual(["src/voice/trtc/trtc-sdk-surface.ts", "src/voice/trtc/trtc-transcriber-adapter.ts"]);
  });

  it("lets the voice server import only the shared contract from src/voice", () => {
    for (const file of SERVER) {
      for (const { specifier } of imports(file)) {
        if (specifier.startsWith("@/voice/")) expect(specifier, file).toBe("@/voice/trtc/trtc-usersig-contract");
        expect(specifier, file).not.toMatch(/^@\/(ai|app\/api\/ai|application\/ai|storage|components)\/|^trtc-sdk-v5|^react/);
      }
    }
  });

  it("keeps every voice route out of the page graph, and the page graph free of the SDK, the signer and the secret", () => {
    const graph = importGraph(["src/app/page.tsx"]);
    expect(graph.filter((file) => file.startsWith("src/app/api/voice/"))).toEqual([]);
    for (const file of graph) expect(read(file), file).not.toMatch(/TRTC_SDK_SECRET_KEY|tls-sig-api-v2/);
  });

  it("keeps the voice route minimal: force-dynamic, POST and the availability GET, one environment read, the handler and the signer", () => {
    const code = strip(read(ROUTE));
    expect([...code.matchAll(/export\s+(?:const|async function|function)\s+(\w+)/g)].map((match) => match[1])).toEqual(["dynamic", "POST", "GET"]);
    expect(code).toMatch(/export const dynamic = "force-dynamic";/);
    expect(code.match(/process\.env/g)).toHaveLength(1);
    expect(code).toMatch(/createVoiceUserSigHandler\(\{ environment: process\.env, signer: signTrtcUserSig \}\)/);
    expect(imports(ROUTE).map(({ specifier }) => specifier)).toEqual(["./voice-usersig-handler", "./voice-usersig-signer"]);
    // The test-only support module is in no route graph.
    expect(importGraph([ROUTE])).not.toContain("src/app/api/voice/usersig/voice-usersig-test-support.ts");
  });

  it("keeps the Packet 13 browser harness and its scripted fake out of every product import", () => {
    for (const file of walk("src").filter((path) => !isTest(path))) {
      for (const { specifier } of imports(file)) expect(specifier, file).not.toMatch(/e2e\/packet-13|harness-app/);
    }
    // The scripted fake transcriber is imported only by tests and the TEST-ONLY harness, never by a product module.
    const fakeImporters = walk("src").filter((file) => !isTest(file) && imports(file).some(({ specifier }) => /fake-voice-transcriber/.test(specifier)));
    expect(fakeImporters).toEqual([]);
    expect(existsSync(join(ROOT, "e2e/packet-13/harness/harness-app.tsx"))).toBe(true);
    expect(read("e2e/packet-13/harness/harness-app.tsx")).toMatch(/JAGAON-P13-ISOLATED-VOICE-HARNESS/);
  });

  it("sets no edge runtime on any route", () => {
    for (const file of walk("src/app/api").filter((path) => path.endsWith("route.ts"))) expect(strip(read(file)), file).not.toMatch(/runtime\s*=\s*["']edge["']/);
  });

  it("reads the environment only in the route, names the secret only in the configuration, and has one network call", () => {
    for (const file of VOICE_SOURCES) {
      const raw = read(file);
      const code = strip(raw);
      if (file !== ROUTE && file !== ACCESS_ROUTE) expect(code, file).not.toMatch(/process\.env|import\.meta\.env|NEXT_PUBLIC_|\bBearer\b/);
      if (file === ACCESS_ROUTE) {
        expect(code.match(/process\.env/g), file).toHaveLength(1);
        expect(code, file).toMatch(/createVoiceAccessHandler\(\{ environment: process\.env \}\)/);
        expect(code, file).not.toMatch(/NEXT_PUBLIC_|import\.meta\.env|signer|TRTC_/);
      }
      if (file !== CONFIG) expect(raw, file).not.toMatch(/TRTC_SDK_SECRET_KEY/);
      if (file === CREDENTIAL_CLIENT) expect(code.match(/\bfetch\s*\(/g), file).toHaveLength(1);
      else expect(code, file).not.toMatch(NETWORK);
      // Name hazards for the existing whole-src scans.
      expect(raw, file).not.toMatch(/"QUALIFIED"|abstentionReason|stream: false/);
    }
    for (const file of [...DOMAIN_APPLICATION, ...PROVIDER, ...SERVER]) expect(file).not.toMatch(/(^|\/)ai(\/|-)|safety-(event|delivery|router)/);
  });
});
