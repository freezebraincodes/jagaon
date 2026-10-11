// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Owner-approved Tencent build-time exclusion (2026-10-11): next.config.ts reads `JAGAON_BUILD_EXCLUDE_TRTC` at build time. With "1"
 * it aliases the TRTC SDK packages to local stubs (Turbopack `resolveAlias`, used by `next build` in this Next 16 setup, and webpack
 * `resolve.alias` for `next build --webpack`) and inlines `JAGAON_TRTC_EXCLUDED=1`; otherwise nothing is aliased and the constant is
 * "0". The built output itself is checked by the documented scratch scan (see the round-5 report); this pins the configuration.
 * (Kept next to its subject, under src/: the owner's checkout git-ignores new files under /tests.)
 */
const ROOT = process.cwd();
async function loadConfig(value: string | undefined) {
  vi.resetModules();
  const previous = process.env.JAGAON_BUILD_EXCLUDE_TRTC;
  if (value === undefined) delete process.env.JAGAON_BUILD_EXCLUDE_TRTC;
  else process.env.JAGAON_BUILD_EXCLUDE_TRTC = value;
  try {
    return (await import("../../next.config")).default as Record<string, unknown> & { env?: Record<string, string>; turbopack?: { resolveAlias?: Record<string, string> }; webpack?: (config: { resolve?: { alias?: Record<string, unknown> } }) => { resolve: { alias: Record<string, unknown> } } };
  } finally {
    if (previous === undefined) delete process.env.JAGAON_BUILD_EXCLUDE_TRTC;
    else process.env.JAGAON_BUILD_EXCLUDE_TRTC = previous;
  }
}
afterEach(() => vi.resetModules());

describe("Tencent build-time exclusion (next.config)", () => {
  it("JAGAON_BUILD_EXCLUDE_TRTC=1 aliases both TRTC packages to existing local stubs and inlines the exclusion constant", async () => {
    const config = await loadConfig("1");
    expect(config.env).toEqual({ JAGAON_TRTC_EXCLUDED: "1" });
    const aliases = config.turbopack?.resolveAlias ?? {};
    expect(Object.keys(aliases).sort()).toEqual(["trtc-sdk-v5", "trtc-sdk-v5/plugins/realtime-transcriber"]);
    for (const target of Object.values(aliases)) {
      expect(target).toMatch(/^\.\/src\/voice\/trtc\/excluded\//);
      expect(existsSync(join(ROOT, target)), target).toBe(true);
    }
    const webpack = config.webpack!({ resolve: { alias: { existing: "kept" } } });
    expect(webpack.resolve.alias).toMatchObject({ existing: "kept", "trtc-sdk-v5$": join(ROOT, "src/voice/trtc/excluded/trtc-sdk-stub.ts"), "trtc-sdk-v5/plugins/realtime-transcriber$": join(ROOT, "src/voice/trtc/excluded/realtime-transcriber-stub.ts") });
  });

  it("a normal build is unchanged: no alias, no webpack hook, the constant is 0; any other value is not the switch", async () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      const config = await loadConfig(value);
      expect(config.env, String(value)).toEqual({ JAGAON_TRTC_EXCLUDED: "0" });
      expect(config.turbopack, String(value)).toBeUndefined();
      expect(config.webpack, String(value)).toBeUndefined();
      expect(typeof config.headers).toBe("function");
    }
  });
});
