import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
        file === "src/application/history/recorded-history-query.ts" ||
        // HSA-bounded mode preview (owner decision 2026-10-14): the History UI reads the preview contract only.
        file === "src/application/preview/preview-insights-query.ts" ||
        file === "src/application/preview/habit-trend.ts",
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

  it("Packet 11C B1a: reaches only the approved care-draft notice copy among AI modules (inside the B2b browser allow-list)", () => {
    // The renderer stores the approved notices (one runtime source: AI_LANGUAGE_COPY.careDraftNotices via careDraftNoticesFor).
    // That closure is the copy, the notice selector, deep-freeze and the domain AI contracts; no service, provider port or network.
    const graph = graphOf(PACKET_9C_ENTRYPOINTS);
    expect(graph.filter((file) => /^src\/(application|domain)\/ai\//.test(file)).sort()).toEqual([
      "src/application/ai/language/ai-language-copy.ts",
      "src/application/ai/language/care-draft-notices.ts",
      "src/domain/ai/ai-invocation-audit.ts",
      "src/domain/ai/ai-language-shell-contracts.ts",
      "src/domain/ai/ai-task-contracts.ts",
      "src/domain/ai/index.ts",
    ]);
    // Only the renderer imports it; the printable artifact, query, invalidation and the service's other modules do not.
    const importers = graph.filter((file) => file.startsWith("src/application/care-preparation/") && /@\/application\/ai\//.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    expect(importers.sort()).toEqual(["src/application/care-preparation/deterministic-care-summary-renderer.ts"]);
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

describe("Packet 11B Kie server-only boundary", () => {
  const all = (dir: string): string[] =>
    readdirSync(join(PROJECT_ROOT, dir)).flatMap((name) => {
      const path = `${dir}/${name}`;
      return statSync(join(PROJECT_ROOT, path)).isDirectory() ? all(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const SERVER_ONLY = (file: string) => file.startsWith("src/ai/kie/") || file.startsWith("src/app/api/ai/");

  it("lets only the Kie modules and the AI route read KIE_API_KEY; no public copy exists", () => {
    for (const file of all("src")) {
      const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_KIE/);
      if (/KIE_API_KEY/.test(source)) expect(SERVER_ONLY(file), file).toBe(true);
    }
  });

  it("lets only src/ai and the AI route import the Kie adapter", () => {
    for (const file of all("src")) {
      const imports = [...readFileSync(join(PROJECT_ROOT, file), "utf8").matchAll(STATIC_IMPORT)].map((match) => match[1]!);
      if (imports.some((specifier) => specifier.startsWith("@/ai/kie") || (file.startsWith("src/ai/") && specifier.includes("/kie/")))) {
        expect(file.startsWith("src/ai/") || file.startsWith("src/app/api/ai/"), file).toBe(true);
      }
    }
  });

  it("lets only the output validator and the evaluation boundary import the shared meaning rules", () => {
    const importers = all("src").filter((file) => /ai-meaning-rules/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")) && file !== "src/application/ai/ai-meaning-rules.ts");
    expect(importers.filter((file) => file !== "src/application/ai/ai-output-validator.ts" && file !== "src/application/ai/language/shell-validator.ts" && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
    // No client or route graph reaches the evaluation diagnostics.
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.startsWith("src/ai/evaluation/")), entry).toEqual([]);
    }
  });

  it("keeps the closed abstention reason out of the route, UI, application service and production audit", () => {
    const ALLOWED = [
      "src/domain/ai/ai-task-contracts.ts",
      "src/domain/ai/ai-test-fixtures.ts",
      "src/domain/ai/ai-language-shell-contracts.ts",
      "src/ai/prompts/packet-11-prompts.ts",
      "src/ai/kie/kie-responses-contracts.ts",
      "src/ai/prompts/packet-11-shell-prompts.ts",
      "src/ai/kie/kie-shell-contracts.ts",
      // Packet 11C B1b (deliberate, narrow): the AI-assisted care projection re-runs the shell gates on a candidate it builds itself from
      // already-accepted wording, with the schema's required `abstentionReason: null`; it never reads, stores or shows a model's reason.
      "src/application/care-preparation/ai-care-summary-replacement.ts",
    ];
    const mentions = all("src").filter((file) => !/\.test\.tsx?$/.test(file) && readFileSync(join(PROJECT_ROOT, file), "utf8").includes("abstentionReason"));
    expect(mentions.filter((file) => !ALLOWED.includes(file) && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
  });

  it("confines the raw request/response trace facility to the Packet 11 live evaluation runner", () => {
    const importers = all("src").filter((file) => file !== "src/ai/evaluation/packet-11-live-trace.ts" && /packet-11-live-trace/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    // No production module imports it; only the explicit live runner (a test file) wires it in.
    expect(importers).toEqual([]);
    expect(readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8")).toMatch(/from "\.\/packet-11-live-trace"/);
    expect(all("src").filter((file) => readFileSync(join(PROJECT_ROOT, file), "utf8").includes("KIE_EVALUATION_RAW_TRACE") && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.includes("packet-11-live-trace")), entry).toEqual([]);
    }
  });

  it("confines the traced hybrid shell diagnostic to its explicit live runner", () => {
    const importers = all("src").filter((file) => file !== "src/ai/evaluation/packet-11-hybrid-live-diagnostic.ts" && /packet-11-hybrid-live-diagnostic/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    // No production module imports it; only the explicit live runner (a test file) wires it in.
    expect(importers).toEqual([]);
    expect(readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-live-hybrid-diagnostic.test.ts"), "utf8")).toMatch(/from "\.\/packet-11-hybrid-live-diagnostic"/);
    expect(all("src").filter((file) => readFileSync(join(PROJECT_ROOT, file), "utf8").includes("RUN_LIVE_HYBRID_SHELL_DIAGNOSTIC") && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.includes("packet-11-hybrid-live-diagnostic")), entry).toEqual([]);
    }
  });

  it("confines the FULL hybrid runner tooling (repair-capable tracer, human-review page) to its explicit live runner", () => {
    const importers = all("src").filter((file) => file !== "src/ai/evaluation/packet-11-hybrid-human-review.ts" && /packet-11-hybrid-human-review/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    // No production module imports the review builder; only the explicit FULL runner (a test file) wires it in.
    expect(importers).toEqual([]);
    const runner = readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-live-hybrid-full.test.ts"), "utf8");
    expect(runner).toMatch(/from "\.\/packet-11-hybrid-human-review"/);
    expect(runner).toMatch(/from "\.\/packet-11-hybrid-live-diagnostic"/);
    expect(runner).toMatch(/RUN_LIVE_HYBRID_SHELL_FULL === "1"/);
    // The review builder never reaches the tracer, the provider adapters or the network.
    const review = readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-hybrid-human-review.ts"), "utf8");
    expect(review).not.toMatch(/packet-11-hybrid-live-diagnostic|@\/ai\/kie|@\/ai\/deepseek|fetch\s*\(|https?:\/\/|process\.env|localStorage/);
    expect(all("src").filter((file) => /RUN_LIVE_HYBRID_SHELL_FULL|HYBRID_FULL_/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")) && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.includes("packet-11-hybrid-human-review") || file.includes("packet-11-live-hybrid-full") || file.includes("packet-11-hybrid-live-diagnostic")), entry).toEqual([]);
    }
  });

  it("confines the targeted six-fixture EXPLAIN diagnostic runner (evaluation-only, env-gated, never reachable from the app)", () => {
    const runner = readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-live-hybrid-targeted.test.ts"), "utf8");
    expect(runner).toMatch(/from "\.\/packet-11-hybrid-live-diagnostic"/);
    expect(runner).toMatch(/from "\.\/packet-11-hybrid-human-review"/);
    expect(runner).toMatch(/RUN_LIVE_HYBRID_SHELL_TARGETED === "1"/);
    // The offline part never reads a credential file or switches another runner on.
    expect(runner).not.toMatch(/\.env\.local|RUN_OFFLINE_HYBRID_REPLAY|RUN_LIVE_HYBRID_SHELL_(?:SMOKE|FULL|DIAGNOSTIC)\b/);
    expect(all("src").filter((file) => /RUN_LIVE_HYBRID_SHELL_TARGETED|HYBRID_TARGETED_/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")) && !file.startsWith("src/ai/evaluation/"))).toEqual([]);
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.includes("packet-11-live-hybrid-targeted")), entry).toEqual([]);
    }
  });

  it("keeps the rules r8 offline replay network-free and evaluation-only (env-gated, fetch stubbed, no live switch, keys refused)", () => {
    const replay = readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-offline-hybrid-replay.test.ts"), "utf8");
    expect(replay).toMatch(/RUN_OFFLINE_HYBRID_REPLAY === "1"/);
    expect(replay).toMatch(/vi\.stubGlobal\("fetch"/);
    expect(replay).toMatch(/REPLAY_REQUIRES_PROVIDER_KEYS_UNSET/);
    expect(replay).not.toMatch(/RUN_LIVE_|readDeepSeekToken|\.env\.local/);
    expect(all("src").filter((file) => readFileSync(join(PROJECT_ROOT, file), "utf8").includes("RUN_OFFLINE_HYBRID_REPLAY"))).toEqual([]);
  });

  it("keeps the eval.18 offline reassessment network-free and evaluation-only (env-gated, fetch stubbed, no live switch, keys refused)", () => {
    const tool = readFileSync(join(PROJECT_ROOT, "src/ai/evaluation/packet-11-offline-hybrid-reassessment.test.ts"), "utf8");
    expect(tool).toMatch(/RUN_OFFLINE_HYBRID_REASSESSMENT === "1"/);
    expect(tool).toMatch(/vi\.stubGlobal\("fetch"/);
    expect(tool).toMatch(/REASSESSMENT_REQUIRES_PROVIDER_KEYS_UNSET/);
    expect(tool).not.toMatch(/RUN_LIVE_|RUN_OFFLINE_HYBRID_REPLAY|readDeepSeekToken|\.env\.local/);
    // Only the test file itself names the switch; no module, route or client graph reaches it.
    expect(all("src").filter((file) => /RUN_OFFLINE_HYBRID_REASSESSMENT|OFFLINE_REASSESSMENT_UNDER_EVAL_18/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")))).toEqual([]);
    for (const entry of ["src/app/page.tsx", "src/app/api/ai/task/route.ts", "src/app/api/onemap/search/route.ts"]) {
      expect(graphOf([entry]).filter((file) => file.includes("packet-11-offline-hybrid-reassessment")), entry).toEqual([]);
    }
  });

  it("builds every Kie Responses request in the one retention-safe adapter used by the route and the live runners", () => {
    const builders = all("src").filter((file) => /stream:\s*false/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    // Packet 13 (P13X): plus the transcript-extraction body builder (its own prompt/schema; same stream/store literals, pinned there).
    // Tell JagaOn understands more (owner-approved design 2026-10-14, deliberate): plus the feelings-chat body builder (its own prompt and
    // schema; the same stream/store literals, pinned below; server-only, reached only from POST /api/ai/feelings).
    // HSA preview "Get general information with AI" (owner-approved 2026-10-14, deliberate): plus the medicine-information body builder
    // (its own prompt and schema; the same stream/store literals; server-only, reached only from POST /api/ai/medicine-info).
    expect(builders).toEqual(["src/ai/feelings-chat/feelings-chat-request.ts", "src/ai/kie/kie-responses-provider.ts", "src/ai/medicine-info/medicine-info-request.ts", "src/ai/transcript-extraction/transcript-extraction-request.ts"]);
    for (const builder of builders) expect(readFileSync(join(PROJECT_ROOT, builder), "utf8")).toMatch(/stream: false,\s*store: false,/);
    for (const file of ["src/ai/evaluation/packet-11-live-kie.test.ts", "src/ai/evaluation/packet-11-live-latency.test.ts"]) {
      const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
      expect(source, file).toMatch(/createKieResponsesProvider\(/);
      expect(source, file).not.toMatch(/stream:\s*false|"store"|store:/);
    }
    // Packet 11C B2a, deliberate retarget: the app's one provider route is now POST /api/ai/shell (B-boundary). Its handler builds its
    // request only through the same shared adapter, as the Direct DeepSeek deepseek-flash shell provider (D2), and never writes a
    // request field itself. The retired legacy handler (POST /api/ai/task) constructs no provider at all.
    const shell = readFileSync(join(PROJECT_ROOT, "src/app/api/ai/shell/ai-shell-handler.ts"), "utf8");
    expect(shell).toMatch(/createDeepSeekShellResponsesProvider\(/);
    expect(shell).not.toMatch(/stream:\s*false|"store"|store:|createKieResponsesProvider\(|createDeepSeekResponsesProvider\(|createKieShellResponsesProvider\(/);
    expect(readFileSync(join(PROJECT_ROOT, "src/app/api/ai/task/ai-task-handler.ts"), "utf8")).not.toMatch(/create\w*Provider\(|from\s+["']@\/ai\//);
  });

  it("lets only the projector, fallbacks and task service read the approved-meaning registry, never the browser graph", () => {
    const importers = all("src").filter((file) => file !== "src/application/ai/ai-meaning-registry.ts" && /ai-meaning-registry/.test(readFileSync(join(PROJECT_ROOT, file), "utf8")));
    // The evaluation harnesses (legacy eval.4 and hybrid eval.6) read only the revision constant; they are unreachable from the route and client graphs.
    // The evaluation-only FULL human-review page renders the EXPLAIN limitation copy with the service's own renderer (confined above).
    expect(importers.sort()).toEqual(["src/ai/evaluation/packet-11-evaluation.ts", "src/ai/evaluation/packet-11-fixtures.ts", "src/ai/evaluation/packet-11-hybrid-evaluation.ts", "src/ai/evaluation/packet-11-hybrid-human-review.ts", "src/application/ai/ai-fallbacks.ts", "src/application/ai/ai-hybrid-task-service.ts", "src/application/ai/ai-task-service.ts", "src/application/ai/detached-payload-projector.ts"]);
    // Packet 11C B2b (D1, deliberate retarget): the history explanation is wired, so the registry now enters the browser graph, only as
    // part of the exact enumerated hybrid closure (packet-11a-manifest.test.ts). In that graph it is reached only through the hybrid
    // service, the fallbacks and the projector the planner uses locally; the legacy service and the evaluation importers stay out.
    const page = graphOf(["src/app/page.tsx"]);
    expect(page).toContain("src/application/ai/ai-meaning-registry.ts");
    expect(importers.filter((file) => page.includes(file)).sort()).toEqual(["src/application/ai/ai-fallbacks.ts", "src/application/ai/ai-hybrid-task-service.ts", "src/application/ai/detached-payload-projector.ts"]);
    const source = readFileSync(join(PROJECT_ROOT, "src/application/ai/ai-meaning-registry.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|KIE_API_KEY|fetch\s*\(|https?:\/\/|@\/ai\/|evaluation/);
  });

  it("keeps the client feature graph away from every server AI module", () => {
    const graph = graphOf(["src/app/page.tsx"]);
    expect(graph.filter((file) => file.startsWith("src/ai/") || file.startsWith("src/app/api/"))).toEqual([]);
    // Packet 11C B2b: the wired browser graph reaches the hybrid service and the browser shell client, never the legacy fact-sending service.
    expect(graph).toContain("src/application/ai/browser-shell-client.ts");
    expect(graph).not.toContain("src/application/ai/ai-task-service.ts");
    expect(graphOf(["src/app/api/onemap/search/route.ts"]).filter((file) => file.startsWith("src/ai/"))).toEqual([]);
    // The evaluation boundary (fixtures, evaluator, latency and reference diagnostics) is unreachable from the AI route.
    expect(graphOf(["src/app/api/ai/task/route.ts"]).filter((file) => file.startsWith("src/ai/evaluation/"))).toEqual([]);
    // Packet 11C B2a: nor from the value-blind shell route, which also never reaches the legacy fact-sending service or projector output path.
    const shellRoute = graphOf(["src/app/api/ai/shell/route.ts"]);
    expect(shellRoute.filter((file) => file.startsWith("src/ai/evaluation/"))).toEqual([]);
    expect(shellRoute).not.toContain("src/application/ai/ai-task-service.ts");
    expect(shellRoute).not.toContain("src/app/api/ai/task/ai-task-handler.ts");
    // The retired legacy route reaches no provider adapter, credential reader or AI service at all.
    expect(graphOf(["src/app/api/ai/task/route.ts"]).filter((file) => file.startsWith("src/ai/") || file.startsWith("src/application/ai/") || file.startsWith("src/domain/ai/"))).toEqual([]);
  });
});
