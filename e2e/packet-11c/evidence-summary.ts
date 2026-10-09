import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Packet 11C C7: Playwright global teardown. Turns the run's records (records.jsonl, written by support.ts) into
 * evidence-summary.json and evidence-summary.md in the same evidence directory. A state is PASS only when it was captured after its
 * checks passed AND its test passed; a captured state of a failed test is FAIL; a planned state never captured is NOT CAPTURED with
 * the reason. Nothing is ever recorded as owner approval.
 */
const HEADER = "Technical evidence — not owner approval; presentation remains human acceptance pending.";

type Context = { target: string; locale: string; viewport: string; engine: string };
type Plan = Context & { kind: "PLAN"; testId: string; title: string; states: string[] };
type State = Context & { kind: "STATE"; testId: string; title: string; state: string; checks: string[]; screenshot: string; aria: string | null };
type Missing = Context & { kind: "NOT_CAPTURED"; testId: string; title: string; state: string; reason: string };
type TestResult = { kind: "TEST"; testId: string; title: string; project: string; status: string; expectedStatus: string; durationMs: number; error: string | null };
type RecordLine = Plan | State | Missing | TestResult;

type Row = Context & { state: string; result: "PASS" | "FAIL" | "NOT CAPTURED"; screenshot: string | null; aria: string | null; checks: string[]; test: string; note: string | null };

export default async function writeEvidenceSummary(): Promise<void> {
  const dir = process.env.C7_EVIDENCE_DIR;
  if (!dir || !existsSync(join(dir, "records.jsonl"))) return;
  const records = readFileSync(join(dir, "records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordLine);
  const tests = new Map<string, TestResult>();
  // Strips terminal colour codes from recorded error lines.
  const plain = (text: string | null) => (text === null ? null : text.replace(/\u001b\[[0-9;]*m/g, ""));
  for (const record of records) if (record.kind === "TEST") tests.set(record.testId, { ...record, error: plain(record.error) });
  const rows: Row[] = [];
  const key = (context: Context, state: string) => `${context.engine}|${context.target}|${context.locale}|${context.viewport}|${state}`;
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "STATE") continue;
    const test = tests.get(record.testId);
    const passed = test?.status === "passed";
    rows.push({ target: record.target, locale: record.locale, viewport: record.viewport, engine: record.engine, state: record.state, result: passed ? "PASS" : "FAIL", screenshot: record.screenshot, aria: record.aria, checks: record.checks, test: record.title, note: passed ? null : `state checks passed, but the test failed later: ${test?.error ?? "no result recorded"}` });
    seen.add(key(record, record.state));
  }
  for (const record of records) {
    if (record.kind !== "NOT_CAPTURED") continue;
    rows.push({ target: record.target, locale: record.locale, viewport: record.viewport, engine: record.engine, state: record.state, result: "NOT CAPTURED", screenshot: null, aria: null, checks: [], test: record.title, note: record.reason });
    seen.add(key(record, record.state));
  }
  for (const record of records) {
    if (record.kind !== "PLAN") continue;
    const test = tests.get(record.testId);
    for (const state of record.states) {
      if (seen.has(key(record, state))) continue;
      seen.add(key(record, state));
      rows.push({ target: record.target, locale: record.locale, viewport: record.viewport, engine: record.engine, state, result: "NOT CAPTURED", screenshot: null, aria: null, checks: [], test: record.title, note: test ? `not reached: the test ${test.status}${test.error ? ` (${test.error})` : ""}` : "not reached: no test result recorded" });
    }
  }
  rows.sort((a, b) => [a.engine, a.target, a.state, a.locale, a.viewport].join("|").localeCompare([b.engine, b.target, b.state, b.locale, b.viewport].join("|")));
  const totals = { PASS: 0, FAIL: 0, "NOT CAPTURED": 0 } as Record<Row["result"], number>;
  for (const row of rows) totals[row.result] += 1;
  const testList = [...tests.values()];
  const summary = {
    header: HEADER,
    kind: "PACKET_11C_C7_BROWSER_EVIDENCE",
    ownerApproval: false,
    humanAcceptance: "PENDING",
    generatedAt: new Date().toISOString(),
    dataUsed: "synthetic only (prepared demo profile and the runtime's synthetic seed)",
    providerCalls: 0,
    aiShellAnswers: "fake bodies served by Playwright route interception (harness); production target tripwired",
    zoomMethod: "200% = 640 CSS px wide viewport at deviceScaleFactor 2 (the 1280 px window at 200% page zoom)",
    totals,
    tests: {
      total: testList.length,
      passed: testList.filter((test) => test.status === "passed").length,
      // A documented defect pinned with test.fail(): it failed, as declared (the defect is still present).
      expectedFailures: testList.filter((test) => test.status === "failed" && test.expectedStatus === "failed").length,
      failed: testList.filter((test) => test.status !== test.expectedStatus && test.status !== "skipped").length,
      skipped: testList.filter((test) => test.status === "skipped").length,
    },
    rows,
    testResults: testList,
  };
  writeFileSync(join(dir, "evidence-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const md: string[] = [
    `# Packet 11C C7 — bilingual browser and accessibility evidence`,
    "",
    `**${HEADER}**`,
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Data: ${summary.dataUsed}. Provider calls: 0. AI shell answers: ${summary.aiShellAnswers}.`,
    `- Zoom: ${summary.zoomMethod}.`,
    `- Totals: ${totals.PASS} PASS, ${totals.FAIL} FAIL, ${totals["NOT CAPTURED"]} NOT CAPTURED. Tests: ${summary.tests.passed}/${summary.tests.total} passed, ${summary.tests.expectedFailures} expected failure (documented defect), ${summary.tests.failed} unexpected failures, ${summary.tests.skipped} skipped. The isolation project's results are in the run log, not in this table.`,
    "",
    "| Engine | Target | State | Locale | Viewport | Result | Screenshot | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.engine} | ${row.target} | ${row.state} | ${row.locale} | ${row.viewport} | ${row.result} | ${row.screenshot ?? "—"} | ${(row.note ?? "").replace(/\|/g, "/")} |`),
    "",
    "## Checks per captured state",
    "",
    ...rows.filter((row) => row.checks.length > 0).flatMap((row) => [`- **${row.engine} ${row.target} ${row.state} ${row.locale} ${row.viewport}** (${row.result}): ${row.checks.join("; ")}${row.aria ? ` — aria snapshot: ${row.aria}` : ""}`]),
    "",
    "## Tests",
    "",
    ...testList.map((test) => `- ${test.status === "failed" && test.expectedStatus === "failed" ? "EXPECTED FAILURE (documented defect, test.fail)" : test.status.toUpperCase()} [${test.project}] ${test.title}${test.error ? ` — ${test.error}` : ""}`),
    "",
  ];
  writeFileSync(join(dir, "evidence-summary.md"), md.join("\n"));
}
