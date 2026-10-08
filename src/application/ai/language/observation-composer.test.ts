import { describe, expect, it, vi } from "vitest";
import { PACKET_11_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import { plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { slotTokenMatcher, type AiLocale, type AtomKind, type ShellFieldPath, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { verifyComposition } from "./assembler";
import { AI_LANGUAGE_COPY, OBSERVATION_GROUPS, type LanguageCopy } from "./ai-language-copy";
import { composeAiResult } from "./ai-composition";
import { atomMultiset, composeDeterministic } from "./deterministic-composition";
import { defaultShells } from "./default-shells";
import { composeLocalShells, composeObservationShell, observationVariantCount, selectObservationVariant } from "./observation-composer";
import { countSentences, stripSlotTokens } from "./shell-validator";
import { planSlots } from "./slot-planner";

/**
 * Observation ownership (owner instruction 2026-10-07, offline): the application composes every EXPLAIN_PATTERN observation from a
 * closed set of approved bilingual templates (ai-language-copy.11b.7); the model writes only the headline and the evidence.
 */
const EXPLAIN = PACKET_11_HYBRID_FIXTURES.filter((fixture) => fixture.taskType === "EXPLAIN_PATTERN");
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
const remoteDefaults = (plan: SlotPlan): ShellTexts => new Map([...defaultShells(plan)].filter(([path]) => path !== "observation")) as ShellTexts;
const observationSlots = (plan: SlotPlan) => plan.fields.find((field) => field.path === "observation")!.requiredSlots;
const prose = (text: string) => stripSlotTokens(text, "").trim();

/** A synthetic EXPLAIN plan with the given observation groups (atom kind, slot count, values per DECIMAL_LIST). */
function syntheticPlan(locale: AiLocale, groups: ReadonlyArray<readonly [AtomKind, number, number?]>): SlotPlan {
  const slots: Array<Record<string, unknown>> = [{ slotId: "S1", atomKind: "MEANING", homeField: "headline", boundRefs: ["claim-1"], orderGroup: null, glossKey: "MEANING_CLAUSE" }];
  for (const [kind, count, values] of groups) {
    for (let index = 0; index < count; index += 1) {
      const refs = kind === "DECIMAL_LIST" ? Array.from({ length: values ?? 1 }, (_, n) => `fact-v${n}`) : [`fact-${slots.length}`];
      slots.push({ slotId: `S${slots.length + 1}`, atomKind: kind, homeField: "observation", boundRefs: refs, orderGroup: null, glossKey: "RECORDED_VALUES" });
    }
  }
  slots.push({ slotId: `S${slots.length + 1}`, atomKind: "COUNT", homeField: "evidence", boundRefs: ["fact-count"], orderGroup: null, glossKey: "EVIDENCE_COUNT" });
  const of = (path: string) => slots.filter((slot) => slot.homeField === path).map((slot) => slot.slotId);
  const budgets = locale === "en-SG" ? { headline: 60, observation: 120, evidence: 80 } : { headline: 50, observation: 90, evidence: 60 };
  return {
    planVersion: "ai-slot-plan.11b.9", taskType: "EXPLAIN_PATTERN", locale, runtimeBundleKey: BUNDLE.bundleKey, claimFamily: "COMPARABLE_SLOT_TREND",
    fields: [
      { path: "headline", requiredSlots: of("headline"), maxCodePoints: budgets.headline, maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE" },
      { path: "observation", requiredSlots: of("observation"), maxCodePoints: budgets.observation, maxSentences: 2, mayBeAtomOnly: false, owner: "LOCAL" },
      { path: "evidence", requiredSlots: of("evidence"), maxCodePoints: budgets.evidence, maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE" },
    ],
    slots, sections: [], remote: { eligible: true },
  } as unknown as SlotPlan;
}

describe("observation composer (ai-language-copy.11b.7)", () => {
  it("has two approved non-default variants per locale; variant 0 is the default copy", () => {
    expect(observationVariantCount("en-SG")).toBe(2);
    expect(observationVariantCount("zh-SG")).toBe(2);
  });

  it("variant 0 reproduces today's default observation wording exactly", () => {
    const cases: Array<[AiLocale, ReadonlyArray<readonly [AtomKind, number, number?]>, string]> = [
      ["en-SG", [["DECIMAL_LIST", 1, 2]], "Recorded values: {{S2}}."],
      ["en-SG", [["DATE", 2]], "Recorded dates: {{S2}} and {{S3}}."],
      ["en-SG", [["DECIMAL_LIST", 1, 2], ["LABEL", 2]], "Recorded values: {{S2}}. Recorded items, in your own words: “{{S3}}” and “{{S4}}”."],
      ["en-SG", [["DATE_RANGE", 1], ["TIME", 3]], "Recorded period: {{S2}}. Recorded times: {{S3}}, {{S4}} and {{S5}}."],
      ["zh-SG", [["DECIMAL_LIST", 1, 2]], "记录的数值：{{S2}}。"],
      ["zh-SG", [["DECIMAL_LIST", 1, 2], ["LABEL", 2]], "记录的数值：{{S2}}。记录的项目（您的原文）：“{{S3}}” 和 “{{S4}}”。"],
      ["zh-SG", [["DATE", 2]], "记录的日期：{{S2}} 和 {{S3}}。"],
    ];
    for (const [locale, groups, expected] of cases) expect(composeObservationShell(syntheticPlan(locale, groups), 0)).toBe(expected);
    // Every fixture: variant 0 equals the observation of the deterministic default shells.
    for (const fixture of EXPLAIN) {
      const { plan } = plannedFixture(fixture.id);
      expect(composeObservationShell(plan, 0), fixture.id).toBe(defaultShells(plan).get("observation"));
    }
  });

  it("the exact approved variants per shape (en and zh): each group is its own recorded statement, in planned order", () => {
    const table: Array<[string, number, string]> = [
      ["p11.explain-pattern.en-sg.ordinary", 1, "Your records list {{S2}}."],
      ["p11.explain-pattern.en-sg.ordinary", 2, "The recorded values are {{S2}}."],
      ["p11.explain-pattern.en-sg.missing-data", 1, "Your records list {{S2}}."],
      ["p11.explain-pattern.en-sg.missing-data", 2, "The recorded value is {{S2}}."],
      ["p11.explain-pattern.en-sg.abstention", 1, "Your records include entries dated {{S2}} and {{S3}}."],
      ["p11.explain-pattern.en-sg.abstention", 2, "The recorded dates are {{S2}} and {{S3}}."],
      ["p11.explain-pattern.en-sg.forbidden-adherence", 1, "Your records list {{S2}}. Also recorded, in your own words: “{{S3}}”."],
      ["p11.explain-pattern.en-sg.forbidden-adherence", 2, "The recorded values are {{S2}}. Other recorded item, in your own words: “{{S3}}”."],
      ["p11.explain-pattern.en-sg.forbidden-cause", 1, "Your records list {{S2}}. Also recorded, in your own words: “{{S3}}” and “{{S4}}”."],
      ["p11.explain-pattern.en-sg.forbidden-cause", 2, "The recorded values are {{S2}}. Other recorded items, in your own words: “{{S3}}” and “{{S4}}”."],
      ["p11.explain-pattern.zh-sg.ordinary", 1, "您的记录中列出了{{S2}}。"],
      ["p11.explain-pattern.zh-sg.ordinary", 2, "记录的数值为{{S2}}。"],
      ["p11.explain-pattern.zh-sg.missing-data", 2, "记录的数值为{{S2}}。"],
      ["p11.explain-pattern.zh-sg.abstention", 1, "您在{{S2}} 和 {{S3}}都有记录。"],
      ["p11.explain-pattern.zh-sg.abstention", 2, "记录的日期为{{S2}} 和 {{S3}}。"],
      ["p11.explain-pattern.zh-sg.forbidden-adherence", 1, "您的记录中列出了{{S2}}。另外记录的项目（您的原文）：“{{S3}}”。"],
      ["p11.explain-pattern.zh-sg.forbidden-adherence", 2, "记录的数值为{{S2}}。其他记录项目（您的原文）：“{{S3}}”。"],
      ["p11.explain-pattern.zh-sg.forbidden-cause", 1, "您的记录中列出了{{S2}}。另外记录的项目（您的原文）：“{{S3}}” 和 “{{S4}}”。"],
      ["p11.explain-pattern.zh-sg.forbidden-cause", 2, "记录的数值为{{S2}}。其他记录项目（您的原文）：“{{S3}}” 和 “{{S4}}”。"],
    ];
    for (const [id, variant, expected] of table) expect(composeObservationShell(plannedFixture(id).plan, variant), `${id} v${variant}`).toBe(expected);
  });

  it("P1 (ai-language-copy.11b.8): every supplied item is shown verbatim inside the locale quotation marks, in the deterministic default and both AI variants", () => {
    const withItems = EXPLAIN.filter((fixture) => plannedFixture(fixture.id).plan.slots.some((slot) => slot.atomKind === "LABEL"));
    expect(withItems.length).toBeGreaterThanOrEqual(12);
    for (const fixture of withItems) {
      const { request, plan, atoms } = plannedFixture(fixture.id);
      const labels = plan.slots.filter((slot) => slot.atomKind === "LABEL");
      const compositions = [composeDeterministic(request, plan, atoms, BUNDLE), ...[1, 2].map((variant) => {
        const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant });
        expect(result.kind, `${fixture.id} v${variant}`).toBe("ACCEPTED");
        return (result as Extract<typeof result, { kind: "ACCEPTED" }>).composition;
      })];
      for (const composition of compositions) {
        const field = composition.fields.get("observation")!;
        expect(field.text, fixture.id).toMatch(plan.locale === "en-SG" ? /in your own words: “/ : /原文）：“/);
        for (const slot of labels) {
          const span = field.spans.find((entry) => entry.slotId === slot.slotId)!;
          const supplied = request.facts.find((fact) => fact.ref === slot.boundRefs[0])!.value as { text: string };
          // The exact supplied text, unchanged, between “ and ”.
          expect(field.text.slice(span.start, span.end), fixture.id).toBe(supplied.text);
          expect(field.text.slice(span.start - 1, span.start), fixture.id).toBe("“");
          expect(field.text.slice(span.end, span.end + 1), fixture.id).toBe("”");
        }
      }
    }
  });

  it("P1: supplied text with quotation marks, braces, markup, ampersands and reference-like words is kept byte-for-byte and verified", () => {
    for (const [id, text] of [
      ["p11.explain-pattern.en-sg.prompt-injection", "He said “stop” & <b>now</b> {{S2}} fact-12 \\ 'x'"],
      ["p11.explain-pattern.zh-sg.prompt-injection", "他说“停”＆<b>现在</b> {{S2}} fact-12"],
    ] as const) {
      const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === id)!;
      const request = structuredClone(fixture.request) as any;
      request.facts.find((fact: any) => fact.field === "INTAKE_LABEL").value.text = text;
      const planned = planSlots(request, BUNDLE);
      expect(planned.kind, id).toBe("PLANNED");
      if (planned.kind !== "PLANNED") continue;
      const label = planned.plan.slots.find((slot) => slot.atomKind === "LABEL")!;
      for (const composition of [composeDeterministic(request, planned.plan, planned.atoms, BUNDLE), ...[1, 2].map((variant) => (composeAiResult(request, planned.plan, planned.atoms, remoteDefaults(planned.plan), BUNDLE, { variant }) as any).composition)]) {
        expect(composition, id).toBeDefined();
        const field = composition.fields.get("observation")!;
        const span = field.spans.find((entry: { slotId: string }) => entry.slotId === label.slotId)!;
        expect(field.text.slice(span.start - 1, span.end + 1), id).toBe(`“${text}”`);
        expect(verifyComposition(request, BUNDLE, composition).kind, id).toBe("ACCEPTED");
      }
    }
  });

  it("P1: the items group stays within the observation budget for one to nine items in every variant", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      for (let items = 1; items <= 9; items += 1) {
        const plan = syntheticPlan(locale, [["DECIMAL_LIST", 1, 2], ["LABEL", items]]);
        for (let variant = 0; variant <= observationVariantCount(locale); variant += 1) {
          const text = composeObservationShell(plan, variant);
          const field = plan.fields.find((entry) => entry.path === "observation")!;
          expect([...prose(text)].length, `${locale} ${items} v${variant}`).toBeLessThanOrEqual(field.maxCodePoints);
          expect(countSentences(prose(text)), `${locale} ${items} v${variant}`).toBeLessThanOrEqual(2);
          expect(text.match(/“\{\{S\d+\}\}”/g), `${locale} ${items} v${variant}`).toHaveLength(items);
        }
      }
    }
  });

  it("the variants never link facts or label dates as readings or items as notes", () => {
    const LINKS = /\b(?:for|alongside|with|noted|note|notes|linked|because|after|before|during|reading|readings|earlier|recent|cause|caused|related)\b|对应|由于|因为|之后|之前|读数|备注|较早|近期/i;
    for (const locale of ["en-SG", "zh-SG"] as const) {
      for (const variant of AI_LANGUAGE_COPY.explainObservationVariants[locale]) {
        // Packet 11C (11b.9): the `periods` group is excluded here. Its one approved template ("Readings by period — …" /
        // "按期间的读数：…", pinned exactly in ai-language-copy.test.ts) frames the PERIOD_SUMMARY atom, which is by design a summary of
        // readings per period; it is the same in the default and every variant, so no variant adds a link or a label.
        const groups = Object.entries(variant).filter(([name]) => name !== "periods").map(([, group]) => group);
        expect(groups).toHaveLength(5);
        for (const group of groups) for (const position of Object.values(group)) for (const text of Object.values(position)) expect(text, text).not.toMatch(LINKS);
      }
    }
  });

  it("selection is deterministic from the requestId, always a non-default variant, and both variants occur across the fixtures", () => {
    const seen = new Set<number>();
    for (const fixture of EXPLAIN) {
      const variant = selectObservationVariant(fixture.request.requestId, fixture.request.locale);
      expect(variant).toBe(selectObservationVariant(fixture.request.requestId, fixture.request.locale));
      expect(variant).toBeGreaterThanOrEqual(1);
      expect(variant).toBeLessThanOrEqual(2);
      seen.add(variant);
    }
    expect([...seen].sort()).toEqual([1, 2]);
    // Pinned (FNV-1a 32-bit over the UTF-8 requestId, then 1 + hash mod 2).
    expect(selectObservationVariant("00000000-0000-4000-8000-000000000001", "en-SG")).toBe(1);
    expect(selectObservationVariant("00000000-0000-4000-8000-000000000002", "en-SG")).toBe(2);
    expect(selectObservationVariant("00000000-0000-4000-8000-000000000015", "en-SG")).toBe(2);
    expect(selectObservationVariant("00000000-0000-4000-8000-000000000032", "zh-SG")).toBe(1);
  });

  it("every variant of every group combination fits the observation budget (en 120 / zh 90 code points, 2 sentences)", () => {
    const kinds: ReadonlyArray<readonly [AtomKind, string]> = [["DECIMAL_LIST", "values"], ["DATE", "dates"], ["DATE_RANGE", "ranges"], ["TIME", "times"], ["LABEL", "items"]];
    const combos: Array<ReadonlyArray<readonly [AtomKind, number, number?]>> = [];
    for (const [first] of kinds) for (const count of [1, 3]) combos.push([[first, first === "DECIMAL_LIST" ? 1 : count, count]]);
    for (let a = 0; a < kinds.length; a += 1) for (let b = a + 1; b < kinds.length; b += 1) for (const count of [1, 3]) combos.push([[kinds[a]![0], kinds[a]![0] === "DECIMAL_LIST" ? 1 : count, count], [kinds[b]![0], count]]);
    for (const locale of ["en-SG", "zh-SG"] as const) {
      for (const groups of combos) {
        const plan = syntheticPlan(locale, groups);
        for (let variant = 1; variant <= observationVariantCount(locale); variant += 1) {
          const local = composeLocalShells(plan, variant);
          const text = local.get("observation")!;
          expect([...prose(text)].length, `${locale} ${JSON.stringify(groups)} v${variant}`).toBeLessThanOrEqual(locale === "en-SG" ? 120 : 90);
          expect(countSentences(prose(text))).toBeLessThanOrEqual(2);
          expect([...text.matchAll(slotTokenMatcher())].map((match) => match[1])).toEqual([...observationSlots(plan)]);
        }
      }
    }
  });

  it("Packet 11C (11b.9): a PERIOD_SUMMARY slot is the periods group, last in order, with one approved template in the default and every variant", () => {
    expect(OBSERVATION_GROUPS).toEqual(["values", "dates", "ranges", "times", "items", "periods"]);
    const expected = { "en-SG": "Readings by period — {{S2}}.", "zh-SG": "按期间的读数：{{S2}}。" } as const;
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const plan = syntheticPlan(locale, [["PERIOD_SUMMARY", 1]]);
      for (let variant = 0; variant <= observationVariantCount(locale); variant += 1) expect(composeObservationShell(plan, variant), `${locale} v${variant}`).toBe(expected[locale]);
      expect(defaultShells(plan).get("observation")).toBe(expected[locale]);
      for (let variant = 1; variant <= observationVariantCount(locale); variant += 1) {
        const text = composeLocalShells(plan, variant).get("observation")!;
        expect([...prose(text)].length).toBeLessThanOrEqual(locale === "en-SG" ? 120 : 90);
        expect(countSentences(prose(text))).toBe(1);
      }
    }
  });

  it("composeLocalShells fails closed: an unknown variant, an over-budget template or a care plan's observation", () => {
    const { plan } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    expect(() => composeLocalShells(plan, 3)).toThrow("OBSERVATION_COMPOSITION_INVALID");
    expect(() => composeLocalShells(plan, 0.5)).toThrow("OBSERVATION_COMPOSITION_INVALID");
    const long = structuredClone(AI_LANGUAGE_COPY) as any;
    long.explainObservationVariants["en-SG"][0].values.first.other = `Your records list {values}${" and more words".repeat(10)}.`;
    expect(() => composeLocalShells(plan, 1, long as LanguageCopy)).toThrow("OBSERVATION_COMPOSITION_INVALID");
    const threeSentences = structuredClone(AI_LANGUAGE_COPY) as any;
    threeSentences.explainObservationVariants["en-SG"][0].values.first.other = "Here. Your records. List {values}.";
    expect(() => composeLocalShells(plan, 1, threeSentences as LanguageCopy)).toThrow("OBSERVATION_COMPOSITION_INVALID");
    expect(composeLocalShells(plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary").plan, 1).size).toBe(0);
  });
});

describe("AI composition: model headline and evidence + deterministic observation (S9, S10)", () => {
  it("every EXPLAIN fixture, both variants: each observation slot exactly once in planned order (provenance spans), exact atoms and references, real r7 ACCEPTED", () => {
    for (const fixture of EXPLAIN) {
      const { request, plan, atoms } = plannedFixture(fixture.id);
      const deterministic = composeDeterministic(request, plan, atoms, BUNDLE);
      for (let variant = 1; variant <= 2; variant += 1) {
        const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant });
        expect(result.kind, `${fixture.id} v${variant}`).toBe("ACCEPTED");
        if (result.kind !== "ACCEPTED") continue;
        const observation = result.composition.fields.get("observation" as ShellFieldPath)!;
        expect(observation.spans.map((span) => span.slotId), fixture.id).toEqual([...observationSlots(plan)]);
        for (const span of observation.spans) expect(observation.text.slice(span.start, span.end)).toBe(atoms[span.slotId]!.text);
        expect(atomMultiset(result.composition)).toEqual(atomMultiset(deterministic));
        expect(result.composition.output.inputRefsUsed).toEqual(deterministic.output.inputRefsUsed);
        expect(JSON.stringify((result.composition.output.payload as any).observation.claimRefs)).toBe(JSON.stringify((deterministic.output.payload as any).observation.claimRefs));
        expect(JSON.stringify((result.composition.output.payload as any).evidence.factRefs)).toBe(JSON.stringify((deterministic.output.payload as any).evidence.factRefs));
        expect(verifyComposition(request, BUNDLE, result.composition).kind).toBe("ACCEPTED");
        expect(observation.text).not.toBe(deterministic.fields.get("observation" as ShellFieldPath)!.text);
      }
    }
  });

  it("the variant defaults to the requestId selection", () => {
    const { request, plan, atoms } = plannedFixture("p11.explain-pattern.en-sg.forbidden-adherence");
    const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE);
    expect(result).toMatchObject({ kind: "ACCEPTED", observationVariant: 2 });
    if (result.kind === "ACCEPTED") expect(result.composition.output.payload).toMatchObject({ observation: { text: "The recorded values are 10.4 mmol/L and 11.1 mmol/L. Other recorded item, in your own words: “forgot breakfast tablet”." } });
  });

  it("remote shells carrying the application-owned observation, or missing a remote field, are an invariant failure (S10, hard)", () => {
    const { request, plan, atoms } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const withObservation = new Map(defaultShells(plan)) as ShellTexts;
    expect(composeAiResult(request, plan, atoms, withObservation, BUNDLE, { variant: 1 })).toMatchObject({ kind: "REJECTED", gate: "S10", invariant: "COMPOSER", reason: "FACT_FIDELITY_FAILED" });
    const missing = new Map([["headline", "This looks at {{S1}}."]]) as ShellTexts;
    expect(composeAiResult(request, plan, atoms, missing, BUNDLE, { variant: 1 })).toMatchObject({ kind: "REJECTED", gate: "S10", invariant: "COMPOSER" });
    expect(composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant: 7 })).toMatchObject({ kind: "REJECTED", gate: "S10", invariant: "COMPOSER" });
  });

  it("S10 runs over the composed observation: an approved-copy variant that r7 rejects falls to a hard S10 rejection", () => {
    const { request, plan, atoms } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const bad = structuredClone(AI_LANGUAGE_COPY) as any;
    bad.explainObservationVariants["en-SG"][0].values.first.other = "Your records list {values}, which is too high.";
    const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant: 1, copy: bad as LanguageCopy });
    expect(result).toMatchObject({ kind: "REJECTED", gate: "S10", invariant: "VERIFIER" });
    const verify = vi.fn(verifyComposition);
    composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant: 1, verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect((verify.mock.calls[0]![2].output.payload as any).observation.text).toBe("Your records list 6.2 mmol/L and 7.1 mmol/L.");
  });

  it("S9 adjacency still applies to the composed observation; since P1 (11b.8) a quoted item cannot stutter against the copy", () => {
    const { request, plan, atoms } = plannedFixture("p11.explain-pattern.en-sg.forbidden-authority");
    const echo = structuredClone(AI_LANGUAGE_COPY) as any;
    echo.explainObservationVariants["en-SG"][0].items.next.one = "Your records also list {items}.";
    // Before P1 the item atom ("list for the clinic visit") followed "list" directly and S9 rejected the duplicate. The quotation mark
    // now separates the person's text from the copy ("list “list for the clinic visit”"), so S9 has nothing to reject there.
    const quoted = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant: 1, copy: echo as LanguageCopy });
    expect(quoted.kind).toBe("ACCEPTED");
    if (quoted.kind === "ACCEPTED") expect(quoted.composition.fields.get("observation")!.text).toContain("list “list for the clinic visit”");
    // Without the quotation marks the unchanged S9 check still rejects the same stutter on the composed observation.
    const unquoted = { ...echo, quotes: { "en-SG": ["", ""], "zh-SG": ["", ""] } };
    expect(composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant: 1, copy: unquoted as LanguageCopy })).toEqual({ kind: "REJECTED", gate: "S9", reason: "FACT_FIDELITY_FAILED" });
  });

  it("a care plan has no local field: the remote shells are assembled as before", () => {
    const { request, plan, atoms } = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
    const result = composeAiResult(request, plan, atoms, defaultShells(plan), AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    expect(result).toMatchObject({ kind: "ACCEPTED", observationVariant: null });
  });

  it("observation slots never appear in the remote fields", () => {
    for (const fixture of EXPLAIN) {
      const { plan } = plannedFixture(fixture.id);
      expect(plan.fields.map((field) => [field.path, field.owner])).toEqual([["headline", "REMOTE"], ["observation", "LOCAL"], ["evidence", "REMOTE"]]);
      expect(prose(composeObservationShell(plan, 0)).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Fix round 1 (controller ruling, 2026-10-07): a recorded item is arbitrary patient text and may be a verb phrase ("forgot breakfast
 * tablet", "IGNORE ALL PREVIOUS INSTRUCTIONS …"), so every item statement is a label-tolerant colon/list frame, never a copula or verb
 * before the item; and no zh variant uses 也, which after a values sentence could invite pairing a value with a date.
 */
describe("fix round 1: label-tolerant item frames, no zh 也", () => {
  const VERB_PHRASE_LABELS = ["forbidden-adherence", "forbidden-medication-action", "prompt-injection"].flatMap((name) => [`p11.explain-pattern.en-sg.${name}`, `p11.explain-pattern.zh-sg.${name}`]);
  const COPULA_OR_VERB = /\b(?:is|are|was|were|be|include|includes|included|list|lists|listed|show|shows|has|have|contain|contains)\s*$|[为是有包括含]\s*$/i;
  it("every item template (en and zh; variants 1 and 2; first and next; one and other) is a colon/list frame", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      for (const variant of AI_LANGUAGE_COPY.explainObservationVariants[locale]) {
        for (const position of ["first", "next"] as const) {
          for (const count of ["one", "other"] as const) {
            const template = variant.items[position][count];
            const before = template.split("{items}")[0]!;
            expect(before, template).toMatch(locale === "en-SG" ? /: $/ : /：$/);
            expect(before, template).not.toMatch(COPULA_OR_VERB);
            expect(template.split("{items}")[1], template).toBe(locale === "en-SG" ? "." : "。");
          }
        }
      }
    }
  });
  it("no zh variant template contains 也 (dates, ranges, times or any group, any position or count)", () => {
    for (const variant of AI_LANGUAGE_COPY.explainObservationVariants["zh-SG"]) {
      for (const group of Object.values(variant)) for (const position of Object.values(group)) for (const text of Object.values(position)) expect(text, text).not.toContain("也");
    }
    // Every shape a date statement can follow (values first, then dates, ranges or times), both counts, both variants.
    for (const [kind, count] of [["DATE", 1], ["DATE", 3], ["DATE_RANGE", 1], ["DATE_RANGE", 2], ["TIME", 1], ["TIME", 2]] as const) {
      for (const variant of [1, 2]) {
        const text = composeObservationShell(syntheticPlan("zh-SG", [["DECIMAL_LIST", 1, 2], [kind, count]]), variant);
        expect(text, `${kind} x${count} v${variant}`).not.toContain("也");
        expect(text.split("。").filter(Boolean)).toHaveLength(2);
      }
    }
  });
  it.each(VERB_PHRASE_LABELS)("%s: in every variant the item atom follows a colon frame and the composition is accepted by S9 and the real r7", (id) => {
    const { request, plan, atoms } = plannedFixture(id);
    const labels = plan.slots.filter((slot) => slot.atomKind === "LABEL").map((slot) => slot.slotId);
    expect(labels.length).toBeGreaterThan(0);
    for (const variant of [1, 2]) {
      const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant });
      expect(result.kind, `${id} v${variant}`).toBe("ACCEPTED");
      if (result.kind !== "ACCEPTED") continue;
      const observation = result.composition.fields.get("observation" as ShellFieldPath)!;
      const first = observation.spans.find((span) => span.slotId === labels[0])!;
      const before = observation.text.slice(0, first.start);
      // P1 (11b.8): the colon frame is followed by the opening quotation mark of the person's own words.
      expect(before, `${id} v${variant}`).toMatch(request.locale === "en-SG" ? /: “$/ : /：“$/);
      expect(before.slice(0, -1), `${id} v${variant}`).not.toMatch(COPULA_OR_VERB);
      expect(observation.text.slice(first.start, first.end)).toBe(atoms[labels[0]!]!.text);
    }
  });
});

describe("fact preservation guard: the composed template carries exactly the planned observation tokens", () => {
  // Unvalidated copy (bypassing buildLanguageCopy) is the only way to reach the guard; it proves the composer itself refuses a
  // template that would drop, duplicate or reorder an observation fact, instead of relying on later gates.
  const withValues = (template: string): LanguageCopy => ({ ...AI_LANGUAGE_COPY, explainDefaults: { ...AI_LANGUAGE_COPY.explainDefaults, "en-SG": { ...AI_LANGUAGE_COPY.explainDefaults["en-SG"], values: template } } }) as LanguageCopy;
  const plan = plannedFixture("p11.explain-pattern.en-sg.ordinary").plan;
  it("refuses a template that duplicates an observation token", () => {
    const token = `{{${plan.fields.find((f) => f.path === "observation")!.requiredSlots[0]}}}`;
    expect(() => composeObservationShell(plan, 0, withValues(`Recorded values: {values}, again ${token}.`))).toThrow("OBSERVATION_COMPOSITION_INVALID");
  });
  it("refuses a template that drops the values token", () => {
    expect(() => composeObservationShell(plan, 0, withValues("Recorded values are listed."))).toThrow("OBSERVATION_COMPOSITION_INVALID");
  });
  it("accepts the approved template (control)", () => {
    expect([...composeObservationShell(plan, 0).matchAll(slotTokenMatcher())].map((m) => m[1])).toEqual(plan.fields.find((f) => f.path === "observation")!.requiredSlots);
  });
});
