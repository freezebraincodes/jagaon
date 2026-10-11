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
import { SLOT_PLAN_VERSION, type ShellTask } from "@/domain/ai";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";
import { CURRENT_SLOT_PLAN_VERSION, differingPaths, normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";
import { normalise11b20Prompt } from "./packet-11-prompt-change-normalisation";

/**
 * Presentation correction guard (owner instruction 2026-10-08, offline): the P1/P3 presentation changes are application-only. The 70
 * model-facing request bodies and every fixture's remote eligibility must stay byte-identical to their state before the change, pinned
 * here as a digest captured from the unchanged code. When the private INDEPENDENT_CONFIRMATION_RUN trace is on disk, every current body
 * is also compared with the exact bytes that run sent.
 *
 * Version-only difference (Packet 11C phase 2, owner decision option (a), 2026-10-08, offline): ai-slot-plan.11b.9 changes only the
 * planner's remote-eligibility accounting, so every body now differs from its historical body in the slot-plan version field and nowhere
 * else. Both comparisons below go through the documented structural normalisation (`normaliseSlotPlanVersion`: exactly the shell input's
 * `slotPlanVersion` and the output schema's echo enum, 11b.9 -> 11b.8, twice per body, counted): the normalised bodies and every
 * eligibility must still equal the historical digest and the confirmation run's bytes. The current (un-normalised) digest is pinned too.
 * 11b.20 candidate (offline): provenance comparison first maps the whole instructions back to the exact 11b.18 asset and the embedded
 * runtimeBundleKey (20 -> 18), then the two historical slot-plan values. The original historical digest remains unchanged. This proves
 * bounded byte changes only; it does not make old provider outputs evidence for the new prompt. The 140 count is slot-plan fields only.
 */
const HISTORICAL_DIGEST = "a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92";
const CURRENT_DIGEST = "aa7064a24fe1a1eb95ba0ba62b54ce2990844f89d5b8d4aa292870f1b9d8e856";
const SENTINEL = "ds-SENTINEL-CREDENTIAL-presentation-guard";
const NOW = () => "2026-10-08T00:00:00.000Z";
const CONFIRMATION_TRACE = "test-results/packet-11-hybrid-live-trace/20261007T131032Z-6a13e8630a3464c8";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
/** Exported (Packet 11C Task 4, no behaviour change): the source-backed byte guard captures its bodies with this exact function. */
export async function capture(fixture: Pick<AiEvaluationFixture, "request" | "taskType">): Promise<{ eligibility: string; body: string | null }> {
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
const digestOf = (rows: ReadonlyArray<{ id: string; eligibility: string; body: string | null }>) => sha256(rows.map((row) => `${row.id}|${row.eligibility}|${row.body === null ? "-" : sha256(row.body)}`).join("\n"));
/** Exported (Packet 11C Task 4, no behaviour change): the digest of the 70 current bodies and eligibilities, as pinned below (CURRENT_DIGEST). */
export async function existingFixtureDigest(): Promise<string> {
  return digestOf(await snapshot());
}

/** The rows with every body structurally normalised to the historical slot plan version; each body must carry exactly 2 occurrences. */
function normalisedRows(rows: ReadonlyArray<{ id: string; eligibility: string; body: string | null }>) {
  return rows.map((row) => {
    if (row.body === null) return { ...row, occurrences: 0 };
    const normalised = normaliseSlotPlanVersion(normalise11b20Prompt(row.body));
    return { ...row, body: normalised.body, occurrences: normalised.occurrences };
  });
}
/**
 * Exported (Packet 11C phase 2): the 70-fixture digest after the documented version-only normalisation (must equal HISTORICAL_DIGEST),
 * with the number of version fields it rewrote (must be 70 x 2).
 */
export async function versionNormalisedFixtureDigest(): Promise<{ digest: string; occurrences: number }> {
  const rows = normalisedRows(await snapshot());
  return { digest: digestOf(rows), occurrences: rows.reduce((sum, row) => sum + row.occurrences, 0) };
}

describe("Packet 11 presentation correction guard (offline)", () => {
  it("the 70 bodies and eligibility preserve historical bytes apart from the two prompt edits, bundle key and slot-plan fields", async () => {
    expect(SLOT_PLAN_VERSION).toBe(CURRENT_SLOT_PLAN_VERSION);
    const rows = await snapshot();
    expect(rows).toHaveLength(70);
    expect(rows.filter((row) => row.eligibility === '{"eligible":true}')).toHaveLength(70);
    const normalised = normalisedRows(rows);
    // The normalisation is never a silent no-op: exactly the two version fields of every body, 140 in all.
    expect(normalised.filter((row) => row.occurrences !== SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY).map((row) => row.id)).toEqual([]);
    expect(normalised.reduce((sum, row) => sum + row.occurrences, 0)).toBe(70 * SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
    expect(digestOf(normalised)).toBe(HISTORICAL_DIGEST);
    expect(digestOf(rows)).toBe(CURRENT_DIGEST);
  });

  it.runIf(existsSync(CONFIRMATION_TRACE))("every current body, normalised to the historical slot plan version, is byte-identical to the body the confirmation run sent", async () => {
    const rows = normalisedRows(await snapshot());
    const callMap = JSON.parse(readFileSync(join(CONFIRMATION_TRACE, "99-call-map.json"), "utf8")) as { callMap: { entries: Array<{ sequence: number; fixtureId: string; attempt: number }> } };
    const files = readdirSync(CONFIRMATION_TRACE);
    const sent = new Map(callMap.callMap.entries.filter((entry) => entry.attempt === 1).map((entry) => {
      const name = files.find((file) => file.startsWith(`${String(entry.sequence).padStart(3, "0")}-`) && file.endsWith(".request.json"))!;
      return [entry.fixtureId, (JSON.parse(readFileSync(join(CONFIRMATION_TRACE, name), "utf8")) as { bodyText: string }).bodyText];
    }));
    expect(sent.size).toBe(70);
    expect(rows.filter((row) => row.occurrences !== SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY).map((row) => row.id)).toEqual([]);
    // Any difference other than the slot-plan version field fails with the differing keys.
    expect(rows.filter((row) => row.body !== sent.get(row.id)).map((row) => `${row.id}: ${differingPaths(row.body!, sent.get(row.id)!).join(", ")}`)).toEqual([]);
  });
});
