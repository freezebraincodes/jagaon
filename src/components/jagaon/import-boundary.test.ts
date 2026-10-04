import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());
const SOURCE_ROOT = join(PROJECT_ROOT, "src");
const ENTRYPOINT = join(SOURCE_ROOT, "app", "page.tsx");

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const STATIC_IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

function resolveSourceImport(fromFile: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith("@/")) {
    candidate = join(SOURCE_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidate = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }

  const candidates = extname(candidate)
    ? [candidate]
    : [
        ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => join(candidate, `index${extension}`)),
      ];

  return candidates.find((file) => existsSync(file)) ?? null;
}

function collectRuntimeGraph(entrypoint: string): Set<string> {
  const visited = new Set<string>();
  const pending = [entrypoint];

  while (pending.length > 0) {
    const file = normalize(pending.pop()!);
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const imported = resolveSourceImport(file, match[1]!);
      if (imported && !visited.has(imported)) pending.push(imported);
    }
  }

  return visited;
}

/** The only engine modules Packet 7A may compose into the runtime. */
const PACKET_7A_ENGINE_MODULES = [
  "src/learning/familiar-item-learning-evaluator.ts",
  "src/patterns/comparable-slot-trend-evaluator.ts",
  "src/patterns/familiar-or-frequent-item-evaluator.ts",
  "src/patterns/pattern-evaluator-contracts.ts",
  "src/patterns/pattern-evaluator-support.ts",
];

/** The only Inquiry engine modules Packet 8 may compose into the runtime. */
const PACKET_8_INQUIRY_MODULES = [
  "src/inquiry/barrier-response.ts",
  "src/inquiry/barrier-template.ts",
  "src/inquiry/inquiry-arbiter.ts",
  "src/inquiry/inquiry-capability-manifest.ts",
  "src/inquiry/inquiry-lifecycle-rules.ts",
  "src/inquiry/medication-occasion-barrier.ts",
];

function graphOf(entrypoints: string[]): string[] {
  const graph = new Set<string>();
  for (const entry of entrypoints) {
    for (const file of collectRuntimeGraph(join(PROJECT_ROOT, entry))) {
      graph.add(relative(PROJECT_ROOT, file).replaceAll("\\", "/"));
    }
  }
  return [...graph].sort();
}

describe("Packet 7A runtime import boundary", () => {
  it("reaches only the enabled Learning, Pattern and Packet 8 Inquiry modules, never Safety or live providers", () => {
    const graph = graphOf(["src/app/page.tsx"]);
    const engines = graph.filter((file) => file.startsWith("src/learning/") || file.startsWith("src/patterns/"));
    expect(engines).toEqual(PACKET_7A_ENGINE_MODULES);
    expect(graph.filter((file) => file.startsWith("src/inquiry/"))).toEqual(PACKET_8_INQUIRY_MODULES);

    const forbidden = graph.filter((file) =>
      file.startsWith("src/domain/safety/") ||
      file.startsWith("src/safety/") ||
      file.startsWith("src/ai/") ||
      /(?:^|\/)(?:live|google|onemap)[^/]*(?:provider|places|maps?)[^/]*\.[jt]sx?$/.test(file),
    );
    expect(forbidden, `Forbidden runtime imports:\n${forbidden.join("\n")}`).toEqual([]);
    expect(graph).toContain("src/components/jagaon/JagaOnApp.tsx");
    expect(graph).toContain("src/components/jagaon/screens/RecordedHistoryScreen.tsx");
  });

  it("has no Packet 7B evaluator module or runtime path", () => {
    const graph = graphOf(["src/app/page.tsx"]);
    const deferred = graph.filter((file) =>
      /routine-shift|recurring-barrier|prescribed-timing|context-bounded|return-toward|cross-variable|routine-learning|barrier-learning|context-learning|preference-learning|behaviour-learning/.test(file),
    );
    expect(deferred).toEqual([]);
  });

  it("keeps the Recorded history UI on the narrow port: no Dexie, storage, evaluator or query implementation", () => {
    const graph = graphOf([
      "src/components/jagaon/screens/RecordedHistoryScreen.tsx",
      "src/components/jagaon/history/HistoryReadingsChart.tsx",
      "src/components/jagaon/history/HistoryFactsCard.tsx",
      "src/components/jagaon/history/BookletStamps.tsx",
    ]);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/storage/") ||
        file.startsWith("src/patterns/") ||
        file.startsWith("src/learning/") ||
        file.startsWith("src/application/intelligence/") ||
        file.startsWith("src/application/journal/") ||
        file === "src/application/history/recorded-history-query.ts",
    );
    expect(forbidden, `Forbidden UI imports:\n${forbidden.join("\n")}`).toEqual([]);
    for (const file of graph) {
      const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
      expect(source.includes('from "dexie"'), file).toBe(false);
    }
  });

  it("keeps pure evaluators free of storage, React, network, clock and randomness", () => {
    for (const file of PACKET_7A_ENGINE_MODULES) {
      const graph = graphOf([file]);
      expect(graph.filter((path) => path.startsWith("src/storage/") || path.startsWith("src/components/")), file).toEqual([]);
      const code = readFileSync(join(PROJECT_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/from "dexie"/, /from "react"/, /\bfetch\(/, /Date\.now\(/, /new Date\(\)/, /Math\.random/, /crypto\.randomUUID/]) {
        expect(code, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});

describe("Packet 6A onboarding import boundary", () => {
  const ONBOARDING_ENTRYPOINTS = [
    "src/application/onboarding/demo-onboarding-contracts.ts",
    "src/application/onboarding/demo-medicine-catalogue.ts",
    "src/application/onboarding/demo-onboarding-repository.ts",
    "src/application/onboarding/demo-onboarding-edits.ts",
    "src/application/onboarding/prepared-onboarding-fixture.ts",
    "src/components/jagaon/onboarding/OnboardingFlow.tsx",
    "src/components/jagaon/screens/MyMedicinesScreen.tsx",
  ];

  it("imports no Safety, Learning, Pattern, Inquiry, AI, storage or journal write service", () => {
    const graph = new Set<string>();
    for (const entry of ONBOARDING_ENTRYPOINTS) {
      for (const file of collectRuntimeGraph(join(PROJECT_ROOT, entry))) {
        graph.add(relative(PROJECT_ROOT, file).replaceAll("\\", "/"));
      }
    }
    const forbidden = [...graph].filter(
      (file) =>
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/learning/") ||
        file.startsWith("src/patterns/") ||
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/ai/") ||
        file.startsWith("src/storage/") ||
        file.startsWith("src/repositories/") ||
        file.startsWith("src/application/contracts/") ||
        file.startsWith("src/application/journal/journal-command-service") ||
        file.startsWith("src/application/journal/browser-journal-runtime"),
    );
    expect(forbidden, `Forbidden onboarding imports:\n${forbidden.join("\n")}`).toEqual([]);
    expect(graph).toContain("src/application/onboarding/demo-onboarding-repository.ts");
  });
});

describe("Packet 8 import boundary", () => {
  const PACKET_8_ENTRYPOINTS = [
    "src/application/inquiry/inquiry-service.ts",
    "src/application/inquiry/inquiry-persistence.ts",
    "src/application/care-plan/care-plan-command-service.ts",
    "src/application/care-plan/reminder-reconciliation.ts",
    "src/application/medication-schedule/medication-schedule-service.ts",
    "src/application/medication-schedule/synthetic-care-plan-seed.ts",
    ...PACKET_8_INQUIRY_MODULES,
  ];

  it("cannot reach Packet 5A Safety, a Safety policy pack, AI, Packet 7B or a live provider", () => {
    const graph = graphOf(PACKET_8_ENTRYPOINTS);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/ai/") ||
        /routine-shift|recurring-barrier|prescribed-timing|barrier-learning/.test(file) ||
        /(?:^|\/)(?:live|google|onemap)[^/]*(?:provider|places|maps?)[^/]*\.[jt]sx?$/.test(file),
    );
    expect(forbidden, `Forbidden Packet 8 imports:\n${forbidden.join("\n")}`).toEqual([]);
    // The domain schema keeps the capability-discriminated SCREENED variant;
    // no Packet 8 producer may construct it, route Safety or name a policy pack.
    const producers = graph.filter(
      (file) =>
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/application/inquiry/") ||
        file.startsWith("src/application/care-plan/") ||
        file.startsWith("src/application/medication-schedule/"),
    );
    expect(producers.length).toBeGreaterThan(10);
    for (const file of producers) {
      const code = readFileSync(join(PROJECT_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/SAFETY_EVENT|NO_SAFETY_ROUTE|"SCREENED"|SAFETY_ROUTED|policyPack|PolicyPack/);
    }
  });

  it("keeps the Medication schedule UI on the narrow port: no storage, engine, Inquiry service or record writer", () => {
    const graph = graphOf([
      "src/components/jagaon/screens/MedicationScheduleScreen.tsx",
      "src/components/jagaon/primitives/ModalDialog.tsx",
    ]);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/storage/") ||
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/application/journal/") ||
        file.startsWith("src/application/care-plan/") ||
        file === "src/application/inquiry/inquiry-service.ts" ||
        file === "src/application/medication-schedule/medication-schedule-service.ts",
    );
    expect(forbidden, `Forbidden UI imports:\n${forbidden.join("\n")}`).toEqual([]);
  });

  it("keeps pure Inquiry engine modules free of storage, React, network, clock and randomness", () => {
    for (const file of PACKET_8_INQUIRY_MODULES) {
      const graph = graphOf([file]);
      // Only the pure canonical hash helper and its type-level contracts are shared.
      expect(
        graph.filter(
          (path) =>
            path.startsWith("src/storage/") ||
            path.startsWith("src/components/") ||
            (path.startsWith("src/application/") &&
              path !== "src/application/intelligence/metrics.ts" &&
              !path.startsWith("src/application/contracts/")),
        ),
        file,
      ).toEqual([]);
      const code = readFileSync(join(PROJECT_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/from "dexie"/, /from "react"/, /\bfetch\(/, /Date\.now\(/, /new Date\(\)/, /Math\.random/, /crypto\.randomUUID/]) {
        expect(code, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});

describe("Packet 9A nearby-food provider boundary", () => {
  /** The only provider-facing modules Packet 9A composes into the runtime. */
  const PACKET_9A_PROVIDER_MODULES = [
    "src/app/api/onemap/search/onemap-search-handler.ts",
    "src/app/api/onemap/search/route.ts",
    "src/application/nearby-food/browser-map-descriptor.ts",
    "src/application/nearby-food/browser-nearby-food.ts",
    "src/application/nearby-food/hpb-snapshot-schema.ts",
    "src/application/nearby-food/hpb-venue-directory.ts",
    "src/application/nearby-food/nearby-food-contracts.ts",
    "src/application/nearby-food/nearby-food-discovery-service.ts",
    "src/application/nearby-food/onemap-geocoder.ts",
    "src/application/nearby-food/synthetic-nearby-food.ts",
  ];

  it("reaches exactly the approved OneMap/HPB/synthetic modules and no Google adapter", () => {
    const graph = graphOf(["src/app/page.tsx", "src/app/api/onemap/search/route.ts"]);
    const providers = graph.filter((file) => file.startsWith("src/application/nearby-food/") || file.startsWith("src/app/api/"));
    expect(providers).toEqual(PACKET_9A_PROVIDER_MODULES);
    expect(graph.filter((file) => /google/i.test(file))).toEqual([]);
  });
});

describe("Packet 9B care-organisation import boundary", () => {
  const PACKET_9B_ENTRYPOINTS = [
    "src/application/care-organisation/care-organisation-service.ts",
    "src/application/care-organisation/care-organisation-query.ts",
    "src/application/care-organisation/synthetic-care-organisation-seed.ts",
    "src/application/packet9-subscriptions.ts",
  ];

  it("cannot reach Safety, AI, Packet 7B evaluators, Inquiry engines or location search", () => {
    const graph = graphOf(PACKET_9B_ENTRYPOINTS);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/ai/") ||
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/application/nearby-food/") ||
        file.startsWith("src/app/api/") ||
        /routine-shift|recurring-barrier|prescribed-timing|barrier-learning/.test(file),
    );
    expect(forbidden, `Forbidden Packet 9B imports:\n${forbidden.join("\n")}`).toEqual([]);
  });

  it("keeps Screens 09 and 10 on the narrow ports: no storage, services, journal or location modules", () => {
    const graph = graphOf(["src/components/jagaon/screens/PreventiveCareScreen.tsx", "src/components/jagaon/screens/CarePreparationScreen.tsx"]);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/storage/") ||
        file.startsWith("src/application/journal/") ||
        file.startsWith("src/application/care-plan/") ||
        file.startsWith("src/application/nearby-food/") ||
        (file.startsWith("src/application/care-organisation/") && file !== "src/application/care-organisation/care-organisation-contracts.ts"),
    );
    expect(forbidden, `Forbidden UI imports:\n${forbidden.join("\n")}`).toEqual([]);
  });
});

describe("Packet 9C care-preparation import boundary", () => {
  const PACKET_9C_ENTRYPOINTS = [
    "src/application/care-preparation/care-preparation-service.ts",
    "src/application/care-preparation/care-preparation-query.ts",
    "src/application/care-preparation/care-summary-invalidation.ts",
    "src/application/care-preparation/deterministic-care-summary-renderer.ts",
    "src/application/care-preparation/care-summary-artifact.ts",
  ];

  it("cannot reach AI, Safety, Packet 7B evaluators, Packet 10 backup or restore, Inquiry engines or location search", () => {
    const graph = graphOf(PACKET_9C_ENTRYPOINTS);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/ai/") ||
        file.startsWith("src/safety/") ||
        file.startsWith("src/domain/safety/") ||
        file.startsWith("src/inquiry/") ||
        file.startsWith("src/application/nearby-food/") ||
        file.startsWith("src/app/api/") ||
        /backup|restore|import-export|routine-shift|recurring-barrier|prescribed-timing|barrier-learning/.test(file),
    );
    expect(forbidden, `Forbidden Packet 9C imports:\n${forbidden.join("\n")}`).toEqual([]);
  });

  it("keeps the preview screen on narrow ports: no storage, services, journal or location modules", () => {
    const graph = graphOf(["src/components/jagaon/screens/CareSummaryPreviewScreen.tsx", "src/components/jagaon/care-preparation/PrintPort.ts"]);
    const allowed = new Set([
      "src/application/care-preparation/care-preparation-contracts.ts",
      "src/application/care-preparation/care-summary-artifact.ts",
      "src/application/care-preparation/care-summary-locale-pack.ts",
    ]);
    const forbidden = graph.filter(
      (file) =>
        file.startsWith("src/storage/") ||
        file.startsWith("src/application/journal/") ||
        file.startsWith("src/application/care-plan/") ||
        file.startsWith("src/application/nearby-food/") ||
        (file.startsWith("src/application/care-preparation/") && !allowed.has(file)),
    );
    expect(forbidden, `Forbidden UI imports:\n${forbidden.join("\n")}`).toEqual([]);
  });
});

describe("Packet 10 storage, deletion and portability import boundary", () => {
  const PACKET_10_ENTRIES = [
    "src/app/page.tsx",
    "src/application/storage/integrity-gate.ts",
    "src/application/storage/profile-row-codecs.ts",
    "src/application/deletion/permanent-deletion-service.ts",
    "src/storage/delete-dataset.ts",
    "src/storage/migrations/migration-coordinator.ts",
  ];

  it("never reaches Packet 5A Safety records, policy, engine or delivery modules", () => {
    const graph = graphOf(PACKET_10_ENTRIES);
    expect(graph.filter((file) => /^src\/(safety|domain\/safety)\//.test(file) || /safety-(event|delivery|router)/i.test(file))).toEqual([]);
  });

  it("keeps Dexie table access out of Packet 10 UI modules (value imports; types are erased)", () => {
    const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
    const visited = new Set<string>();
    const pending = ["DataBackupScreen.tsx", "IntegrityShell.tsx", "RecordDeletionDialog.tsx", "DeleteAllDialog.tsx"].map((file) => join(SOURCE_ROOT, "components/jagaon/data", file));
    while (pending.length > 0) {
      const file = normalize(pending.pop()!);
      if (visited.has(file)) continue;
      visited.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(VALUE_IMPORT)) {
        const imported = resolveSourceImport(file, match[1]!);
        if (imported && !visited.has(imported)) pending.push(imported);
      }
    }
    const graph = [...visited].map((file) => relative(PROJECT_ROOT, file).replaceAll("\\", "/"));
    expect(graph.filter((file) => /^src\/storage\/(database|table-catalogue)\.ts$|dexie/.test(file))).toEqual([]);
  });
});
