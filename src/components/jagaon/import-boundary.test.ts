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
  it("reaches only the enabled Learning and Pattern evaluators, never Safety, Inquiry or live providers", () => {
    const graph = graphOf(["src/app/page.tsx"]);
    const engines = graph.filter((file) => file.startsWith("src/learning/") || file.startsWith("src/patterns/"));
    expect(engines).toEqual(PACKET_7A_ENGINE_MODULES);

    const forbidden = graph.filter((file) =>
      file.startsWith("src/domain/safety/") ||
      file.startsWith("src/safety/") ||
      file.startsWith("src/inquiry/") ||
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
