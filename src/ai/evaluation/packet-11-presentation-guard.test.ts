// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import type { ShellTask } from "@/domain/ai";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";

/**
 * Presentation correction guard (owner instruction 2026-10-08, offline): the P1/P3 presentation changes are application-only. The 70
 * model-facing request bodies and every fixture's remote eligibility must stay byte-identical to their state before the change, pinned
 * here as a digest captured from the unchanged code. When the private INDEPENDENT_CONFIRMATION_RUN trace is on disk, every current body
 * is also compared with the exact bytes that run sent.
 */
const SENTINEL = "ds-SENTINEL-CREDENTIAL-presentation-guard";
const NOW = () => "2026-10-08T00:00:00.000Z";
const CONFIRMATION_TRACE = "test-results/packet-11-hybrid-live-trace/20261007T131032Z-6a13e8630a3464c8";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
async function capture(fixture: AiEvaluationFixture): Promise<{ eligibility: string; body: string | null }> {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  if (planned.kind !== "PLANNED") return { eligibility: `UNPLANNABLE:${planned.reason}`, body: null };
  const eligibility = JSON.stringify(planned.plan.remote);
  if (planned.plan.remote.eligible !== true) return { eligibility, body: null };
  let body: string | null = null;
  const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: async (_url, init) => {
    body = String(init.body);
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
  return { eligibility, body };
}
async function snapshot() {
  const rows = [];
  for (const fixture of hybridFixturesForPhase("FULL")) {
    const { eligibility, body } = await capture(fixture);
    rows.push({ id: fixture.id, eligibility, body });
  }
  return rows;
}

describe("Packet 11 presentation correction guard (offline)", () => {
  it("the 70 model-facing request bodies and remote eligibility equal the pre-change digest", async () => {
    const rows = await snapshot();
    expect(rows).toHaveLength(70);
    const digest = sha256(rows.map((row) => `${row.id}|${row.eligibility}|${row.body === null ? "-" : sha256(row.body)}`).join("\n"));
    expect(rows.filter((row) => row.eligibility === '{"eligible":true}')).toHaveLength(70);
    expect(digest).toBe("a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92");
  });

  it.runIf(existsSync(CONFIRMATION_TRACE))("every current body is byte-identical to the body the confirmation run sent", async () => {
    const rows = await snapshot();
    const callMap = JSON.parse(readFileSync(join(CONFIRMATION_TRACE, "99-call-map.json"), "utf8")) as { callMap: { entries: Array<{ sequence: number; fixtureId: string; attempt: number }> } };
    const files = readdirSync(CONFIRMATION_TRACE);
    const sent = new Map(callMap.callMap.entries.filter((entry) => entry.attempt === 1).map((entry) => {
      const name = files.find((file) => file.startsWith(`${String(entry.sequence).padStart(3, "0")}-`) && file.endsWith(".request.json"))!;
      return [entry.fixtureId, (JSON.parse(readFileSync(join(CONFIRMATION_TRACE, name), "utf8")) as { bodyText: string }).bodyText];
    }));
    expect(sent.size).toBe(70);
    expect(rows.filter((row) => row.body !== sent.get(row.id)).map((row) => row.id)).toEqual([]);
  });
});
