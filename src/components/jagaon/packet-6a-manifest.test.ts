import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { DEMO_ONBOARDING_ROUTES } from "@/application/onboarding/demo-onboarding-contracts";
import {
  ALL_SCREENS,
  ONBOARDING_ROUTES,
  PACKET_6A_CHILD_SCREENS,
  TOP_LEVEL_SCREENS,
} from "./screen-manifest";

const SOURCE_ROOT = join(process.cwd(), "src");

function sourceFiles(dir = SOURCE_ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles().map((path) => ({
  path: relative(process.cwd(), path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("Packet 6A storage and screen manifest", () => {
  it("uses exactly the 6A onboarding key and the 7A appointment-note selection key", () => {
    expect(DEMO_ONBOARDING_STORAGE_KEY).toBe("jagaon:demo-onboarding:v1");
    const keyLiterals = files.filter((file) => /["'`]jagaon:[^"'`]*["'`]/.test(file.text));
    expect(keyLiterals.map((file) => file.path)).toEqual([
      "src/application/history/appointment-note-selection.ts",
      "src/application/onboarding/demo-onboarding-repository.ts",
    ]);
  });

  it("touches browser storage only through the onboarding storage adapter", () => {
    const users = files.filter((file) => /localStorage|sessionStorage/.test(file.text)).map((file) => file.path);
    // Packet 13 slice (P13S S5, deliberate): the TRTC adapter only REMOVES the transcriber plugin's own `TRTC_RT_<userId>` key after
    // a session (privacy cleanup); it never reads or writes JagaOn data.
    // HSA preview "Get general information with AI" (owner-approved 2026-10-14, deliberate): the medicine-information client keeps its
    // validated answers and the "notice seen" list per normalised medicine name (guarded; no other JagaOn data).
    expect(users).toEqual(["src/application/medicine-info/medicine-info-client.ts", "src/application/onboarding/demo-onboarding-repository.ts", "src/voice/trtc/trtc-transcriber-adapter.ts"]);
  });

  it("writes no authoritative revision or domain event from onboarding modules", () => {
    const onboarding = files.filter(
      (file) =>
        file.path.startsWith("src/application/onboarding/") ||
        file.path.startsWith("src/components/jagaon/onboarding/") ||
        file.path === "src/components/jagaon/screens/MyMedicinesScreen.tsx",
    );
    expect(onboarding.length).toBeGreaterThan(10);
    for (const file of onboarding) {
      // Comments may name what the module never does; scan code only.
      const code = file.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file.path).not.toMatch(/PATIENT_PROFILE|PRESCRIPTION_VERSION|recordRevisions|domainEvents|DomainEvent|commandService/);
    }
  });

  it("keeps the onboarding routes closed and outside the journal screens and tabs", () => {
    expect(ONBOARDING_ROUTES).toBe(DEMO_ONBOARDING_ROUTES);
    expect(PACKET_6A_CHILD_SCREENS).toEqual(["MY_MEDICINES"]);
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "MEDICATION_SCHEDULE", "HISTORY", "MORE"]);
    for (const route of ONBOARDING_ROUTES) expect([...ALL_SCREENS]).not.toContain(route);
  });
});
