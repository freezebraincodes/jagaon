import { rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { defaultShells } from "@/application/ai/language/default-shells";
import { verifyComposition } from "@/application/ai/language/assembler";
import { composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_LOCALES, slotTokenMatcher, type ShellTask, type ShellTexts } from "@/domain/ai";
import { HUMAN_REVIEW_SAMPLE_PER_LOCALE } from "./packet-11-hybrid-evaluation";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { renderCareDraftNotices } from "@/application/ai/language/care-draft-notices";
import { buildHybridHumanReview, escapeReviewHtml, PACKET_11_HYBRID_REVIEW_ROOT, writeHybridHumanReview } from "./packet-11-hybrid-human-review";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Evaluation-only FULL human-review artifact (owner Option A, 2026-10-06, offline). The builder re-assembles every
 * accepted candidate through the planner, the shell gates, the assembler and the composition verifier and renders
 * final user-visible wording only, marking AI shell wording, deterministic fact atoms and deterministic approved
 * wording. It must never carry request/response bodies, headers, glosses, credentials, diagnostics or token text.
 */

const SENTINEL = "ds-SENTINEL-CREDENTIAL-7e11a0c3b9";
const GENERATED_AT = "2026-10-06T09:00:00.000Z";
const written = new Set<string>();
afterAll(() => {
  for (const file of written) rmSync(file, { force: true });
});

function plannedOf(fixture: AiEvaluationFixture) {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  if (planned.kind !== "PLANNED") throw new Error(`UNPLANNABLE ${fixture.id}`);
  return planned;
}
function defaultCandidate(fixture: AiEvaluationFixture, overrides: Record<string, string> = {}): Record<string, unknown> {
  const { plan } = plannedOf(fixture);
  const texts = new Map(defaultShells(plan)) as Map<string, string>;
  for (const [path, text] of Object.entries(overrides)) texts.set(path, text);
  return shellCandidate(plan, texts as unknown as ShellTexts);
}
const byId = (id: string) => PACKET_11_HYBRID_FIXTURES.find((fixture) => fixture.id === id)!;
const allDefaults = () => PACKET_11_HYBRID_FIXTURES.map((fixture) => ({ fixture, candidate: defaultCandidate(fixture) }));
/**
 * Every string the page must never carry, whatever the wording. Request-body keys are matched in their JSON form (raw or
 * escaped): the synthetic prompt-injection question legitimately contains the English word "instructions" as a fact atom.
 */
function forbiddenStrings(): string[] {
  const glosses = Object.values(AI_LANGUAGE_COPY.glosses).flatMap((byLocale) => Object.values(byLocale));
  const prompts = (["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const).flatMap((task) => AI_LOCALES.map((locale) => shellPromptFor(task, locale)!.text.slice(0, 48)));
  return [...glosses, ...prompts, SENTINEL, "{{", "}}", "Bearer", "authorization", "Authorization", "input_text", "max_output_tokens", '"instructions"', "&quot;instructions&quot;", "tokenInventory", "slotPlanVersion", "gloss", "parserStage", "httpStatus", "OUTPUT_TRUNCATED", "TRANSPORT_FAILED", "diagnostic", "https://", "http://", "<link", " src=", "@import", "url(", "fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "indexedDB"];
}

describe("Packet 11 FULL human-review artifact (offline)", () => {
  it("includes every accepted AI output per locale, no sampling, with fixture id, task and locale", () => {
    const artifact = buildHybridHumanReview(allDefaults(), { generatedAt: GENERATED_AT });
    expect(artifact.included).toBe(70);
    expect(artifact.excluded).toBe(0);
    expect(artifact.perLocale).toEqual({ "en-SG": { included: 35, belowMinimum: false }, "zh-SG": { included: 35, belowMinimum: false } });
    // Grouped by locale (en-SG first), fixture order kept within a locale.
    const expectedOrder = AI_LOCALES.flatMap((locale) => PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.locale === locale).map((fixture) => fixture.id));
    expect(artifact.items.map((item) => item.fixtureId)).toEqual(expectedOrder);
    for (const item of artifact.items) {
      const fixture = byId(item.fixtureId);
      expect([item.taskType, item.locale], item.fixtureId).toEqual([fixture.taskType, fixture.locale]);
      expect(artifact.html, item.fixtureId).toContain(`data-fixture-id="${item.fixtureId}"`);
    }
    expect((artifact.html.match(/<article /g) ?? []).length).toBe(70);
    expect((artifact.html.match(/type="radio"/g) ?? []).length).toBe(140);
  });

  it("marks AI shell wording, deterministic fact atoms and deterministic approved wording exactly as assembled", () => {
    const artifact = buildHybridHumanReview(allDefaults(), { generatedAt: GENERATED_AT });
    for (const item of artifact.items) {
      const fixture = byId(item.fixtureId);
      const { plan, atoms } = plannedOf(fixture);
      const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask];
      // With the default shells the model's fields equal the deterministic composition text; the EXPLAIN observation is the
      // application's AI-path variant (observation ownership), labelled deterministic composition, never AI wording.
      const deterministic = composeDeterministic(fixture.request, plan, atoms, bundle);
      const shells = defaultShells(plan);
      const remote = new Map([...shells].filter(([path]) => path !== "observation")) as ShellTexts;
      const composed = composeAiResult(fixture.request, plan, atoms, remote, bundle);
      if (composed.kind !== "ACCEPTED") throw new Error(`${item.fixtureId} ${composed.gate}`);
      for (const field of plan.fields) {
        const block = item.blocks.find((entry) => entry.path === field.path);
        expect(block, `${item.fixtureId} ${field.path}`).toBeDefined();
        const local = field.owner === "LOCAL";
        expect(block!.pieces.map((piece) => piece.text).join(""), `${item.fixtureId} ${field.path}`).toBe((local ? composed.composition : deterministic).fields.get(field.path)!.text);
        const facts = [...(local ? composed.composition.fields.get(field.path)!.spans.map((span) => `{{${span.slotId}}}`).join(" ") : shells.get(field.path)!).matchAll(slotTokenMatcher())].map((match) => atoms[match[1] as keyof typeof atoms]!.text);
        expect(block!.pieces.filter((piece) => piece.kind === "FACT").map((piece) => piece.text), `${item.fixtureId} ${field.path}`).toEqual(facts);
        if (local) {
          expect(block!.label).toBe("Observation (deterministic composition)");
          expect(block!.pieces.every((piece) => piece.kind !== "AI"), `${item.fixtureId} ${field.path}`).toBe(true);
        } else expect(block!.pieces.every((piece) => piece.kind !== "APPROVED"), `${item.fixtureId} ${field.path}`).toBe(true);
      }
      const approved = item.blocks.filter((block) => block.path === null);
      expect(approved.every((block) => block.pieces.every((piece) => piece.kind === "APPROVED")), item.fixtureId).toBe(true);
      if (fixture.taskType === "DRAFT_CARE_PREPARATION_SUMMARY") {
        // Section headings, then (P3, 2026-10-08) the fixed care-draft notices.
        expect(approved.map((block) => block.pieces[0]!.text), item.fixtureId).toEqual([...plan.sections.map((section) => section.heading), ...renderCareDraftNotices(fixture.request).map((notice) => notice.text)]);
      } else {
        // EXPLAIN limitation copy: deterministic approved wording, at least one row per explanation.
        expect(approved.length, item.fixtureId).toBeGreaterThan(0);
        expect(approved.every((block) => block.label === "Limitation"), item.fixtureId).toBe(true);
      }
    }
    expect(artifact.html).toContain('class="ai"');
    expect(artifact.html).toContain('class="fact"');
    expect(artifact.html).toContain('class="det"');
    expect(artifact.html).toContain("This describes your records; it does not explain the cause.");
  });

  it("re-validates every candidate and excludes (and counts) one that is not ACCEPTED, unparsable or duplicated", () => {
    const en = byId("p11.explain-pattern.en-sg.ordinary");
    const zh = byId("p11.explain-pattern.zh-sg.ordinary");
    const care = byId("p11.draft-care-preparation-summary.en-sg.ordinary");
    const artifact = buildHybridHumanReview(
      [
        { fixture: en, candidate: defaultCandidate(en, { headline: "See {{S1}}.", evidence: "Just {{S3}}." }) },
        { fixture: zh, candidate: "{\"schemaVersion\":" },
        { fixture: care, candidate: defaultCandidate(care) },
        { fixture: care, candidate: defaultCandidate(care) },
        { fixture: en, candidate: defaultCandidate(en, { evidence: "Your diabetes notes show {{S3}}." }) },
      ],
      { generatedAt: GENERATED_AT },
    );
    expect(artifact.items.map((item) => item.fixtureId)).toEqual([care.id]);
    expect([artifact.included, artifact.excluded]).toEqual([1, 4]);
    expect(artifact.exclusions).toEqual({ SHELL_REJECTED: 3, DUPLICATE_FIXTURE: 1 });
    expect(artifact.html).not.toContain(en.id);
    expect(artifact.html).not.toContain("diabetes");
    expect(artifact.html).toContain('data-excluded="4"');
  });

  it("P3: a care card shows the fixed draft notices as application wording after the sections, outside every patient fact", () => {
    const care = byId("p11.draft-care-preparation-summary.en-sg.forbidden-authority");
    const zh = byId("p11.draft-care-preparation-summary.zh-sg.forbidden-authority");
    const artifact = buildHybridHumanReview([{ fixture: care, candidate: defaultCandidate(care) }, { fixture: zh, candidate: defaultCandidate(zh) }], { generatedAt: GENERATED_AT });
    for (const [item, locale] of [[artifact.items[0]!, "en-SG"], [artifact.items[1]!, "zh-SG"]] as const) {
      const notices = item.blocks.filter((block) => block.label === "Notice");
      expect(notices.map((block) => block.pieces)).toEqual([
        [{ kind: "APPROVED", text: AI_LANGUAGE_COPY.careDraftNotices.questions[locale] }],
        [{ kind: "APPROVED", text: AI_LANGUAGE_COPY.careDraftNotices.draft[locale] }],
      ]);
      // After every section block, never inside one.
      expect(item.blocks.slice(-2)).toEqual(notices);
    }
    expect(artifact.html).toContain(`<span class="det">${AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]}</span>`);
    const explain = buildHybridHumanReview([{ fixture: byId("p11.explain-pattern.en-sg.prompt-injection"), candidate: defaultCandidate(byId("p11.explain-pattern.en-sg.prompt-injection")) }], { generatedAt: GENERATED_AT });
    expect(explain.items[0]!.blocks.some((block) => block.label === "Notice")).toBe(false);
  });

  it("P2/P4: every card carries an evaluation-only test-case note outside the output (unfamiliar-language question, fake references, injection, count)", () => {
    const ids = [
      "p11.draft-care-preparation-summary.en-sg.abstention",
      "p11.draft-care-preparation-summary.zh-sg.invalid-reference",
      "p11.explain-pattern.zh-sg.invalid-reference",
      "p11.explain-pattern.en-sg.prompt-injection",
      "p11.draft-care-preparation-summary.zh-sg.hidden-limitation",
      "p11.explain-pattern.en-sg.ordinary",
      "p11.explain-pattern.en-sg.forbidden-diagnosis",
    ];
    const artifact = buildHybridHumanReview(ids.map((id) => ({ fixture: byId(id), candidate: defaultCandidate(byId(id)) })), { generatedAt: GENERATED_AT });
    const notes = Object.fromEntries(artifact.items.map((item) => [item.fixtureId, item.caseNotes.join(" ")]));
    expect(notes["p11.draft-care-preparation-summary.en-sg.abstention"]).toContain("unfamiliar-language test question");
    expect(notes["p11.draft-care-preparation-summary.zh-sg.invalid-reference"]).toContain("deliberately fake reference identifiers");
    expect(notes["p11.explain-pattern.zh-sg.invalid-reference"]).toContain("deliberately fake reference identifiers");
    expect(notes["p11.explain-pattern.en-sg.prompt-injection"]).toContain("instruction aimed at the AI");
    // P2: the stated count differs from the listed values (fixture default count 6, two values); both are shown as supplied.
    expect(notes["p11.explain-pattern.en-sg.prompt-injection"]).toContain("states 6 recorded readings but lists only 2 individual values");
    expect(notes["p11.explain-pattern.en-sg.ordinary"]).toContain("states 10 recorded readings but lists only 2 individual values");
    // Three values and a count of three: no count note.
    expect(notes["p11.explain-pattern.en-sg.forbidden-diagnosis"]).not.toContain("individual values");
    expect(notes["p11.draft-care-preparation-summary.zh-sg.hidden-limitation"]).toContain("carries no limitation");
    // The notes sit outside the output rows; the output text is unchanged by them.
    for (const item of artifact.items) for (const block of item.blocks) for (const piece of block.pieces) for (const note of item.caseNotes) expect(piece.text).not.toContain(note);
    expect(artifact.html.match(/<aside class="case-note">/g)).toHaveLength(ids.length);
    expect(artifact.html).toContain("About this test case (evaluation only)");
  });

  it("excludes (and counts) a candidate the composition verifier (S10) does not accept", () => {
    const en = byId("p11.explain-pattern.en-sg.ordinary");
    const zh = byId("p11.explain-pattern.zh-sg.ordinary");
    const verify: typeof verifyComposition = (request, bundle, composition) => (composition.locale === "zh-SG" ? { kind: "REJECTED", reason: "FACT_FIDELITY_FAILED" } as unknown as ReturnType<typeof verifyComposition> : verifyComposition(request, bundle, composition));
    const artifact = buildHybridHumanReview([{ fixture: en, candidate: defaultCandidate(en) }, { fixture: zh, candidate: defaultCandidate(zh) }], { generatedAt: GENERATED_AT, verify });
    expect(artifact.items.map((item) => item.fixtureId)).toEqual([en.id]);
    expect(artifact.exclusions).toEqual({ COMPOSITION_REJECTED: 1 });
    expect(artifact.html).not.toContain(zh.id);
  });

  it(`flags a locale with fewer than ${HUMAN_REVIEW_SAMPLE_PER_LOCALE} accepted outputs`, () => {
    const en = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.locale === "en-SG").slice(0, 19);
    const zh = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.locale === "zh-SG").slice(0, 20);
    const artifact = buildHybridHumanReview([...en, ...zh].map((fixture) => ({ fixture, candidate: defaultCandidate(fixture) })), { generatedAt: GENERATED_AT });
    expect(artifact.perLocale).toEqual({ "en-SG": { included: 19, belowMinimum: true }, "zh-SG": { included: 20, belowMinimum: false } });
    expect(artifact.html).toContain('data-locale-count="en-SG" data-below-minimum="true"');
    expect(artifact.html).toContain('data-locale-count="zh-SG" data-below-minimum="false"');
    expect(artifact.html).toMatch(/en-SG[^<]*19[^<]*below the 20 required/);
  });

  it("contains no raw bodies, headers, glosses, credentials, diagnostics, token text, network or storage use", () => {
    const html = buildHybridHumanReview(allDefaults(), { generatedAt: GENERATED_AT }).html;
    for (const value of forbiddenStrings()) expect(html.includes(value), value).toBe(false);
    // Exactly one inline script and one inline style; nothing external.
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect((html.match(/<style/g) ?? []).length).toBe(1);
    expect(html).toContain("default-src 'none'");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("escapes markup in rendered text", () => {
    expect(escapeReviewHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });

  it("computes a HumanReviewRecord-shaped JSON from the pass/fail controls, with no storage", () => {
    const artifact = buildHybridHumanReview(allDefaults(), { generatedAt: GENERATED_AT });
    const body = artifact.html.slice(artifact.html.indexOf("<body>") + "<body>".length, artifact.html.indexOf("<script>"));
    const script = artifact.html.slice(artifact.html.indexOf("<script>") + "<script>".length, artifact.html.indexOf("</script>"));
    document.body.innerHTML = body;
    new Function(script)();
    const record = () => JSON.parse((document.getElementById("review-record") as HTMLTextAreaElement).value) as unknown;
    expect(record()).toEqual({ "en-SG": { sampled: 0, passed: 0 }, "zh-SG": { sampled: 0, passed: 0 } });
    const choose = (fixtureId: string, value: "pass" | "fail") => {
      const input = document.querySelector<HTMLInputElement>(`article[data-fixture-id="${fixtureId}"] input[value="${value}"]`)!;
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const enIds = artifact.items.filter((item) => item.locale === "en-SG").map((item) => item.fixtureId);
    const zhIds = artifact.items.filter((item) => item.locale === "zh-SG").map((item) => item.fixtureId);
    for (const id of enIds) choose(id, "pass");
    choose(zhIds[0]!, "pass");
    choose(zhIds[1]!, "fail");
    expect(record()).toEqual({ "en-SG": { sampled: 35, passed: 35 }, "zh-SG": { sampled: 2, passed: 1 } });
    choose(zhIds[1]!, "pass");
    expect(record()).toEqual({ "en-SG": { sampled: 35, passed: 35 }, "zh-SG": { sampled: 2, passed: 2 } });
    document.body.innerHTML = "";
  });

  it("writes the page privately (0600 file, 0700 directory) under the Git-ignored review root", async () => {
    const artifact = buildHybridHumanReview(allDefaults(), { generatedAt: GENERATED_AT });
    const file = await writeHybridHumanReview(artifact, { now: () => GENERATED_AT });
    const path = resolve(process.cwd(), file.path);
    written.add(path);
    expect(file.path.startsWith(`${PACKET_11_HYBRID_REVIEW_ROOT}/`)).toBe(true);
    expect(file.path).toMatch(/full-human-review\.html$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    expect(await readFile(path, "utf8")).toBe(artifact.html);
  });
});

/**
 * packet11-eval.13 (FULL policy hybrid-full-policy.1): the page lists every final user-visible output — accepted AI wording and the
 * deterministic fallbacks the patient saw — clearly labelled. A fallback shows only its closed gate/reason codes and the deterministic
 * wording that was shown (never rejected model text); pass/fail controls and the review record cover accepted AI items only.
 */
describe("Packet 11 FULL human-review artifact: deterministic fallbacks (eval.13)", () => {
  const SENTINEL_TEXT = "哨兵甲乙";
  const en = byId("p11.explain-pattern.en-sg.ordinary");
  const zh = byId("p11.explain-pattern.zh-sg.ordinary");
  const injection = byId("p11.explain-pattern.zh-sg.prompt-injection");
  const careEn = byId("p11.draft-care-preparation-summary.en-sg.ordinary");
  const careZh = byId("p11.draft-care-preparation-summary.zh-sg.ordinary");
  const entries = () => [
    { fixture: en, candidate: defaultCandidate(en) },
    { fixture: zh, candidate: defaultCandidate(zh) },
    // The rejected candidate is never an input of a fallback item; a caller that leaks it anyway must not reach the page.
    { fixture: injection, fallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" }, candidate: defaultCandidate(injection, { observation: `建议您留意${SENTINEL_TEXT}：{{S2}}，{{S3}}。` }) },
    { fixture: careEn, fallback: { gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED" } },
    { fixture: careZh, fallback: { gate: null, reason: "PROVIDER_TIMEOUT" } },
  ] as const;

  it("lists accepted AI items and deterministic fallbacks, labelled with closed codes and the deterministic wording that was shown", () => {
    const artifact = buildHybridHumanReview(entries(), { generatedAt: GENERATED_AT });
    expect([artifact.included, artifact.fallbacks, artifact.excluded]).toEqual([2, 3, 0]);
    expect(artifact.perLocale).toEqual({ "en-SG": { included: 1, belowMinimum: true }, "zh-SG": { included: 1, belowMinimum: true } });
    expect(artifact.fallbackPerLocale).toEqual({ "en-SG": 1, "zh-SG": 2 });
    expect(artifact.items.map((item) => [item.fixtureId, item.source, item.fallback])).toEqual([
      [en.id, "AI", null],
      [careEn.id, "DETERMINISTIC", { gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED" }],
      [zh.id, "AI", null],
      [injection.id, "DETERMINISTIC", { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" }],
      [careZh.id, "DETERMINISTIC", { gate: null, reason: "PROVIDER_TIMEOUT" }],
    ]);
    for (const item of artifact.items.filter((entry) => entry.source === "DETERMINISTIC")) {
      const fixture = byId(item.fixtureId);
      const { plan, atoms } = plannedOf(fixture);
      const deterministic = composeDeterministic(fixture.request, plan, atoms, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
      // Exactly the deterministic composition's wording, field by field; nothing is marked as AI wording.
      for (const field of plan.fields) expect(item.blocks.find((block) => block.path === field.path)!.pieces.map((piece) => piece.text).join(""), `${item.fixtureId} ${field.path}`).toBe(deterministic.fields.get(field.path)!.text);
      expect(item.blocks.every((block) => block.pieces.every((piece) => piece.kind !== "AI")), item.fixtureId).toBe(true);
      expect(item.blocks.some((block) => block.pieces.some((piece) => piece.kind === "FACT")), item.fixtureId).toBe(true);
    }
    const html = artifact.html;
    expect(html).not.toContain(SENTINEL_TEXT);
    expect(html).not.toContain("建议您留意");
    for (const value of forbiddenStrings()) expect(html.includes(value), value).toBe(false);
    expect((html.match(/<article /g) ?? []).length).toBe(5);
    expect((html.match(/data-source="AI"/g) ?? []).length).toBe(2);
    expect((html.match(/data-source="DETERMINISTIC"/g) ?? []).length).toBe(3);
    expect(html).toContain(`data-fixture-id="${injection.id}" data-locale="zh-SG" data-source="DETERMINISTIC" data-fallback-gate="S6" data-fallback-reason="CLINICAL_MEANING_VIOLATION"`);
    expect(html).toContain('data-fallback-gate="none" data-fallback-reason="PROVIDER_TIMEOUT"');
    expect(html).toContain("Deterministic fallback shown");
    expect(html).toContain('data-fallback-count="zh-SG"');
    // Controls only on the two accepted AI items.
    expect((html.match(/type="radio"/g) ?? []).length).toBe(4);
    for (const card of html.split("<article ").slice(1)) expect(card.includes('type="radio"'), card.slice(0, 80)).toBe(card.includes('data-source="AI"'));
    expect(html).toContain('data-included="2" data-fallbacks="3" data-excluded="0"');
  });

  it("the review record counts accepted AI items only as sampled", () => {
    const artifact = buildHybridHumanReview(entries(), { generatedAt: GENERATED_AT });
    const body = artifact.html.slice(artifact.html.indexOf("<body>") + "<body>".length, artifact.html.indexOf("<script>"));
    const script = artifact.html.slice(artifact.html.indexOf("<script>") + "<script>".length, artifact.html.indexOf("</script>"));
    document.body.innerHTML = body;
    new Function(script)();
    const record = () => JSON.parse((document.getElementById("review-record") as HTMLTextAreaElement).value) as unknown;
    expect(record()).toEqual({ "en-SG": { sampled: 0, passed: 0 }, "zh-SG": { sampled: 0, passed: 0 } });
    expect(document.getElementById("review-progress")!.textContent).toBe("0 of 2 accepted AI items decided");
    for (const id of [en.id, zh.id]) {
      const input = document.querySelector<HTMLInputElement>(`article[data-fixture-id="${id}"] input[value="pass"]`)!;
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(record()).toEqual({ "en-SG": { sampled: 1, passed: 1 }, "zh-SG": { sampled: 1, passed: 1 } });
    expect(document.getElementById("review-progress")!.textContent).toBe("2 of 2 accepted AI items decided");
    document.body.innerHTML = "";
  });

  it("excludes (and counts) a fallback with an unknown code or a deterministic composition the verifier rejects; the 20-per-locale flag counts AI items only", () => {
    const invalid = buildHybridHumanReview([
      { fixture: en, fallback: { gate: "S99", reason: "CLINICAL_MEANING_VIOLATION" } },
      { fixture: zh, fallback: { gate: "S6", reason: "NOT_A_REASON" } },
      { fixture: careEn, fallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION <b>" } },
    ] as never, { generatedAt: GENERATED_AT });
    expect([invalid.included, invalid.fallbacks, invalid.excluded]).toEqual([0, 0, 3]);
    expect(invalid.exclusions).toEqual({ FALLBACK_CODE_INVALID: 3 });
    expect(invalid.html).not.toContain("S99");
    expect(invalid.html).not.toContain("NOT_A_REASON");
    const verify: typeof verifyComposition = () => ({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED" }) as unknown as ReturnType<typeof verifyComposition>;
    const rejected = buildHybridHumanReview([{ fixture: injection, fallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" } }], { generatedAt: GENERATED_AT, verify });
    expect([rejected.fallbacks, rejected.exclusions]).toEqual([0, { COMPOSITION_REJECTED: 1 }]);
    const enAi = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.locale === "en-SG").slice(0, 19).map((fixture) => ({ fixture, candidate: defaultCandidate(fixture) }));
    const enFallbacks = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.locale === "en-SG").slice(19, 24).map((fixture) => ({ fixture, fallback: { gate: "S6" as const, reason: "CLINICAL_MEANING_VIOLATION" as const } }));
    const flagged = buildHybridHumanReview([...enAi, ...enFallbacks], { generatedAt: GENERATED_AT });
    expect(flagged.perLocale["en-SG"]).toEqual({ included: 19, belowMinimum: true });
    expect(flagged.fallbackPerLocale["en-SG"]).toBe(5);
    expect(flagged.html).toMatch(/en-SG[^<]*19[^<]*below the 20 required/);
  });
});
