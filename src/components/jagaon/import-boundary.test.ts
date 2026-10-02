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

describe("Packet 6 runtime import boundary", () => {
  it("does not reach Safety, live providers, or deferred feature modules", () => {
    const graph = [...collectRuntimeGraph(ENTRYPOINT)].map((file) =>
      relative(PROJECT_ROOT, file).replaceAll("\\", "/"),
    );

    const forbidden = graph.filter((file) =>
      file.startsWith("src/domain/safety/") ||
      file.startsWith("src/safety/") ||
      file.startsWith("src/learning/") ||
      file.startsWith("src/patterns/") ||
      /(?:^|\/)(?:live|google|onemap)[^/]*(?:provider|places|maps?)[^/]*\.[jt]sx?$/.test(file),
    );

    expect(forbidden, `Forbidden runtime imports:\n${forbidden.join("\n")}`).toEqual([]);
    expect(graph).toContain("src/app/page.tsx");
    expect(graph).toContain("src/components/jagaon/JagaOnApp.tsx");
  });
});
