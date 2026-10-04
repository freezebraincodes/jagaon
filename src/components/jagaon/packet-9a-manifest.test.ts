import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/application/intelligence/metrics";
import {
  HPB_FNB_PARTNERS_DATASET_ID,
  HPB_HEALTHIER_EATERIES_DATASET_ID,
  HPB_MENU_CRITERIA,
} from "@/application/nearby-food/nearby-food-contracts";
import { HPB_SNAPSHOT_DESCRIPTOR, HPB_SNAPSHOT_SHA256 } from "@/application/nearby-food/hpb-venue-directory";
import { ONEMAP_TILE_DESCRIPTOR } from "@/application/nearby-food/browser-map-descriptor";
import { hpbSnapshotManifestSchema } from "@/application/nearby-food/hpb-snapshot-schema";

/**
 * Packet 9A release manifest: the provider profile, governed dataset
 * identity and checksums, Google absence, and the location-privacy and
 * health-isolation boundaries are fixed by test.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const STATIC_IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  const candidates = extname(base) ? [base] : [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => `${base}${suffix}`);
  return candidates.find((file) => existsSync(file)) ?? null;
}

function graph(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => join(ROOT, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of source.matchAll(pattern)) {
        const target = resolveImport(file, match[1]!);
        if (target) pending.push(target);
      }
    }
  }
  return [...seen].map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
}

const NEARBY_FOOD_ENTRIES = [
  "src/application/nearby-food/browser-nearby-food.ts",
  "src/app/api/onemap/search/route.ts",
  "src/components/jagaon/screens/NearbyFoodScreen.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("Packet 9A provider and dataset manifest", () => {
  it("fixes the governed dataset identity, versions, checksums and reconciled counts", () => {
    const snapshotBytes = readFileSync(join(ROOT, "public/data/hpb-nearby-food-v1.json"), "utf8");
    const manifest = hpbSnapshotManifestSchema.parse(JSON.parse(readFileSync(join(ROOT, "public/data/hpb-nearby-food-v1.manifest.json"), "utf8")));
    expect(sha256Hex(snapshotBytes)).toBe(HPB_SNAPSHOT_SHA256);
    expect(manifest.snapshot.sha256).toBe(HPB_SNAPSHOT_SHA256);
    expect(manifest.sources.map((source) => [source.role, source.datasetId, source.sha256])).toEqual([
      ["CRITERIA", HPB_FNB_PARTNERS_DATASET_ID, "2052ef28572d39c3067385765bff7675c8f2d460646120ed28cf086becec63af"],
      ["COORDINATES", HPB_HEALTHIER_EATERIES_DATASET_ID, "0611cdc814a4e8a31888d27e615d151f52b87fa6fcb60563d53efb91c8b03ffb"],
    ]);
    expect(manifest.counts).toEqual({
      criteriaInputRows: 3762,
      criteriaAccepted: 731,
      criteriaRejected: 95,
      criteriaUnmatched: 2645,
      criteriaAmbiguous: 291,
      coordinateInputFeatures: 1829,
      coordinateAccepted: 1828,
      coordinateRejected: 1,
      venuesWithGovernedCriteria: 731,
      venuesWithoutGovernedCriteria: 1097,
    });
    expect(manifest.licence).toEqual({ name: "Singapore Open Data Licence version 1.0", url: HPB_SNAPSHOT_DESCRIPTOR.licenceUrl });
  });

  it("uses only the approved OneMap tile profile and the nine exact HPB criteria", () => {
    expect(ONEMAP_TILE_DESCRIPTOR).toEqual({
      kind: "ONEMAP_TILES",
      tileUrlTemplate: "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png",
      minZoom: 11,
      maxZoom: 19,
      privacyUrl: "https://www.onemap.gov.sg/legal/privacystatement.html",
      termsUrl: "https://www.onemap.gov.sg/legal/termsofuse.html",
    });
    expect(HPB_MENU_CRITERIA).toHaveLength(9);
    for (const criterion of HPB_MENU_CRITERIA) expect(criterion).not.toMatch(/\bGI\b|glyc/i);
  });

  it("contains no Google Maps, Places or geocoding adapter", () => {
    for (const file of [...sourceFiles(SRC), ...sourceFiles(join(ROOT, "scripts"))]) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/maps\.googleapis|googleapis\.com\/maps|google\.maps|places\.googleapis|@googlemaps/i);
    }
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies).not.toHaveProperty("@googlemaps/js-api-loader");
  });
});

describe("Packet 9A privacy and health isolation", () => {
  it("never lets nearby-food code reach storage, the journal, health, Inquiry, Safety or AI modules", () => {
    const files = graph(NEARBY_FOOD_ENTRIES);
    const forbidden = files.filter(
      (file) =>
        file.startsWith("src/storage/") ||
        file.startsWith("src/application/journal/") ||
        file.startsWith("src/application/care-plan/") ||
        file.startsWith("src/application/inquiry/") ||
        file.startsWith("src/application/medication-schedule/") ||
        file.startsWith("src/application/history/") ||
        file.startsWith("src/domain/health-records/") ||
        file.startsWith("src/domain/care-plan/") ||
        file.startsWith("src/domain/inquiry/") ||
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/ai/"),
    );
    expect(forbidden, forbidden.join("\n")).toEqual([]);
    expect(files).toContain("src/application/nearby-food/hpb-venue-directory.ts");
  });

  it("persists and logs no location, query or token", () => {
    const files = graph(NEARBY_FOOD_ENTRIES).filter((file) => /nearby-food|onemap|NearbyFood/.test(file));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const code = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/from "dexie"/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /console\.(log|info|warn|error|debug)/, /navigator\.sendBeacon/, /watchPosition/]) {
        expect(code, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("keeps the OneMap token on the server only", () => {
    const clientFiles = graph(["src/components/jagaon/screens/NearbyFoodScreen.tsx"]);
    for (const file of clientFiles) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/ONEMAP_ACCESS_TOKEN|NEXT_PUBLIC_ONEMAP/);
    }
    expect(readFileSync(join(ROOT, "src/app/api/onemap/search/route.ts"), "utf8")).toContain("process.env.ONEMAP_ACCESS_TOKEN");
  });
});
