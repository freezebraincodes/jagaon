import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { HARNESS_URL, PRODUCTION_URL } from "./support";

/**
 * Packet 13 proof of isolation (no browser; run in the clean copy after both builds): the production build output contains no voice
 * harness identifier; the harness build contains it (positive control). The production routes include the voice credential route;
 * the harness has no API route. The base page chunk does not contain the TRTC SDK (it is loaded only by dynamic import).
 */
const ROOT = process.cwd();
const PRODUCTION_NEXT = join(ROOT, ".next");
const HARNESS_NEXT = join(ROOT, "e2e/packet-13/harness/.next");
const FORBIDDEN_IN_PRODUCTION = ["JAGAON-P13-ISOLATED-VOICE-HARNESS", "data-p13-harness", "JagaOn Packet 13 voice harness", "e2e/packet-13", "harness-1"];

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

test.describe("Packet 13 voice harness isolation", () => {
  test("both builds exist", () => {
    expect(existsSync(join(PRODUCTION_NEXT, "BUILD_ID"))).toBe(true);
    expect(existsSync(join(HARNESS_NEXT, "BUILD_ID"))).toBe(true);
  });

  test("the production build contains no harness marker or fake-transcriber script", () => {
    for (const [needle, where] of hits(PRODUCTION_NEXT, FORBIDDEN_IN_PRODUCTION)) expect(where, needle).toEqual([]);
  });

  test("positive control: the harness build contains its marker", () => {
    expect(hits(HARNESS_NEXT, ["JAGAON-P13-ISOLATED-VOICE-HARNESS"]).get("JAGAON-P13-ISOLATED-VOICE-HARNESS")!.length).toBeGreaterThan(0);
  });

  test("routes: production has the voice credential route; the harness has none", () => {
    const production = Object.values(JSON.parse(readFileSync(join(PRODUCTION_NEXT, "app-path-routes-manifest.json"), "utf8")) as Record<string, string>);
    expect(production).toContain("/api/voice/usersig");
    const harness = Object.values(JSON.parse(readFileSync(join(HARNESS_NEXT, "app-path-routes-manifest.json"), "utf8")) as Record<string, string>);
    expect(harness.filter((route) => route.startsWith("/api/"))).toEqual([]);
  });

  test("the served production page carries no harness marker; the harness does", async ({ request }) => {
    const production = await (await request.get(`${PRODUCTION_URL}/`)).text();
    for (const needle of FORBIDDEN_IN_PRODUCTION) expect(production, needle).not.toContain(needle);
    expect(await (await request.get(`${HARNESS_URL}/`)).text()).toContain("JAGAON-P13-ISOLATED-VOICE-HARNESS");
  });
});
