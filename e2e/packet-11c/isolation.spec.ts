import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { HARNESS_URL, PRODUCTION_URL } from "./support";

/**
 * Packet 11C C7 proof of isolation, run in the clean copy after both builds (no browser). The production build output must contain
 * none of the harness identifiers, the test activation or the test-only qualification records; the harness build output must contain
 * them (positive control: the scan finds what it looks for). The production routes are the src/app routes only, and the harness
 * stylesheet equals the production one (layout evidence uses the shipped CSS).
 */

const ROOT = process.cwd();
const PRODUCTION_NEXT = join(ROOT, ".next");
const HARNESS_NEXT = join(ROOT, "e2e/packet-11c/harness/.next");

/** String literals that survive minification: the harness marker and the test-only record fields. */
const FORBIDDEN_IN_PRODUCTION = ["JAGAON-C7-ISOLATED-TEST-HARNESS", "data-c7-harness", "TEST-ONLY: not evidence", "TEST-ONLY: not a sign-off", "JagaOn C7 test harness", "e2e/packet-11c"];
/** Present in the harness build (the positive control). */
const EXPECTED_IN_HARNESS = ["JAGAON-C7-ISOLATED-TEST-HARNESS", "TEST-ONLY: not evidence", "TEST-ONLY: not a sign-off"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "cache") return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function hits(dir: string, needles: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>(needles.map((needle) => [needle, []]));
  for (const file of files(dir)) {
    const text = readFileSync(file).toString("latin1");
    for (const needle of needles) if (text.includes(Buffer.from(needle, "utf8").toString("latin1"))) found.get(needle)!.push(relative(ROOT, file));
  }
  return found;
}

test.describe("Packet 11C C7 isolation", () => {
  test("both builds exist in this copy (built from the same tree)", () => {
    expect(existsSync(join(PRODUCTION_NEXT, "BUILD_ID")), "production build").toBe(true);
    expect(existsSync(join(HARNESS_NEXT, "BUILD_ID")), "harness build").toBe(true);
  });

  test("the production build output contains no harness identifier, test activation or test-only record", () => {
    const found = hits(PRODUCTION_NEXT, FORBIDDEN_IN_PRODUCTION);
    for (const [needle, where] of found) expect(where, needle).toEqual([]);
  });

  test("positive control: the harness build output contains the marker and the test-only records", () => {
    const found = hits(HARNESS_NEXT, EXPECTED_IN_HARNESS);
    for (const [needle, where] of found) expect(where.length, needle).toBeGreaterThan(0);
  });

  test("the production routes are exactly the src/app routes; the harness has no API route", () => {
    const production = JSON.parse(readFileSync(join(PRODUCTION_NEXT, "app-path-routes-manifest.json"), "utf8")) as Record<string, string>;
    // `/_global-error` and `/_not-found` are the framework's own pages.
    expect(Object.values(production).sort()).toEqual(["/", "/_global-error", "/_not-found", "/api/ai/shell", "/api/ai/task", "/api/onemap/search"]);
    const harness = JSON.parse(readFileSync(join(HARNESS_NEXT, "app-path-routes-manifest.json"), "utf8")) as Record<string, string>;
    expect(Object.values(harness).sort()).toEqual(["/", "/_global-error", "/_not-found"]);
  });

  test("the harness stylesheets equal the production stylesheets byte for byte", () => {
    const css = (dir: string) =>
      files(join(dir, "static"))
        .filter((file) => file.endsWith(".css"))
        .map((file) => readFileSync(file, "utf8"))
        .sort();
    expect(css(HARNESS_NEXT)).toEqual(css(PRODUCTION_NEXT));
  });

  test("the served pages: production carries no harness marker; the harness does", async ({ request }) => {
    const production = await (await request.get(`${PRODUCTION_URL}/`)).text();
    for (const needle of FORBIDDEN_IN_PRODUCTION) expect(production, needle).not.toContain(needle);
    const harness = await (await request.get(`${HARNESS_URL}/`)).text();
    expect(harness).toContain("JAGAON-C7-ISOLATED-TEST-HARNESS");
    // The harness has no /api/ai/shell of its own: an unintercepted call would get a 404 (a closed refusal), never a provider.
    expect((await request.post(`${HARNESS_URL}/api/ai/shell`, { data: {} })).status()).toBe(404);
  });
});
