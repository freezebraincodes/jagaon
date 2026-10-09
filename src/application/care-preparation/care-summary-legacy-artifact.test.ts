import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Instant } from "@/domain/shared";
import { CARE_SUMMARY_SECTION_ORDER, careSummaryExportProjection, careSummarySnapshotPayloadSchema, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { careSummaryLocalePack, sectionAssetId } from "./care-summary-locale-pack";
import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { getMessages } from "@/i18n/get-messages";
import { renderDeterministicCareSummary, type CareSummaryDraft } from "./deterministic-care-summary-renderer";
import { printableCareSummary } from "./care-summary-artifact";
import { careSummarySnapshotRevisionCodec } from "./care-preparation-persistence";
import { LEGACY_9C1, acceptedAiCareComposition, AI_AUDIT_REF, AI_VALIDATED_AT, asLegacy11c1AiAssistedPayload, asLegacy9c1Payload, syntheticCareDraft } from "./care-preparation-test-support";
import { projectValidatedAiCareSummary } from "./ai-care-summary-replacement";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";

/**
 * Packet 11C Addendum B, Task B1a (D3, D4): snapshots made by the Packet 9C code path stay byte-identical — their stored payload,
 * content hash and the printable artifact derived from them — after the 11c.1 template, renderer and locale pack.
 *
 * The fixture `fixtures/care-summary-9c1-approved.json` was captured by running the UNCHANGED 9c.1 code (renderer, locale pack and
 * `printableCareSummary`) on `draft()` below, before any B1a edit, and approving it; its file SHA-256 is pinned here.
 */
const FIXTURE_PATH = join(process.cwd(), "src/application/care-preparation/fixtures/care-summary-9c1-approved.json");
const FIXTURE_SHA256 = "fedf0f63fd05ed71110f65efb4d26a81e64087882e4818e2e41faf1ace53a229";
const PINNED = {
  "en-SG": { contentHash: "6350b6fee88a5c87869019e514c088b01c5eab42199d3b0237fc7be5b93fe2f9", artifactHash: "957f8c645e9edd09668721456a1e9809c5e3ed2b7b5d89c10e3c080b80289b13", byteLength: 707 },
  "zh-SG": { contentHash: "a3be065877261cd9ad7327127a76f18c75ee9ec957e366f5c1bb7e1d486cf202", artifactHash: "f4158b8d570393d5311007421bfd8fab34f9392030138adfdc6bcf854cd6d3cd", byteLength: 694 },
} as const;

type FixtureEntry = { approvedPayload: CareSummarySnapshotPayload; printable: { text: string; hash: string; byteLength: number } };
const fixtureBytes = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Record<"en-SG" | "zh-SG", FixtureEntry>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as never;
const ref = <T extends string>(recordType: T, n: number) => ({ recordType, recordId: id(n), revisionId: id(n + 500) }) as never;
const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });

/** The exact draft the fixture was captured from. */
function draft(locale: "en-SG" | "zh-SG"): CareSummaryDraft {
  return {
    locale,
    asOf: "2026-10-04T02:00:00.000Z" as Instant,
    period: { startAt: "2026-09-04T16:00:00.000Z" as Instant, endAtExclusive: "2026-10-04T16:00:00.000Z" as Instant, startDate: "2026-09-05", endDate: "2026-10-04" },
    appointment: { ref: ref("APPOINTMENT", 1), label: "Dr Lim, Bukit Merah Polyclinic", scheduledAt: exact("2026-10-14T01:40:00.000Z") },
    groups: [
      { key: "GLUCOSE", facts: [{ kind: "GLUCOSE", ref: ref("GLUCOSE_READING", 3), occurrence: exact("2026-10-03T13:00:00.000Z"), value: "6.60" }] },
      { key: "WALKS", facts: [{ kind: "ACTIVITY", ref: ref("ACTIVITY_EVENT", 6), occurrence: exact("2026-10-01T00:30:00.000Z"), label: "Bishan Park 公园", minutes: 25 }] },
    ],
    questions: [{ ref: ref("CARE_QUESTION", 7), text: "可以把笔放在包里吗？", language: "zh-SG" }],
    excluded: [{ source: ref("INTAKE_EVENT", 8), reason: "NOT_SELECTED" }],
  };
}

describe("Packet 11C B1a: 9c.1 snapshots and their printable artifacts stay byte-identical (D3, D4)", () => {
  it("uses the fixture exactly as captured from the 9c.1 code path", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(FIXTURE_SHA256);
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const { approvedPayload } = fixture[locale];
      expect([approvedPayload.composition.templateVersion, approvedPayload.rendering.rendererVersion, approvedPayload.rendering.localePackVersion]).toEqual([LEGACY_9C1.templateVersion, LEGACY_9C1.rendererVersion, LEGACY_9C1.localePackVersion]);
      expect([approvedPayload.status, approvedPayload.rendering.contentHash]).toEqual(["APPROVED", PINNED[locale].contentHash]);
    }
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`still validates unchanged, keeps its stored content hash and prints the same bytes (${locale})`, async () => {
      const { approvedPayload, printable } = fixture[locale];
      const before = JSON.stringify(approvedPayload);
      // The current domain schema accepts the stored payload without transforming it (no notice section is required of 9c.1).
      const parsed = careSummarySnapshotPayloadSchema.safeParse(approvedPayload);
      expect(parsed.success && JSON.stringify(parsed.data)).toBe(before);
      // The canonical projection of the stored content still yields the stored (approved) hash.
      const recomputed = await hashCanonicalJson(careSummaryExportProjection({ ...approvedPayload, rendererVersion: approvedPayload.rendering.rendererVersion, localePackVersion: approvedPayload.rendering.localePackVersion }));
      expect(recomputed).toBe(PINNED[locale].contentHash);
      // The printable artifact derived from it now is byte-identical to the one the 9c.1 code produced.
      const now = printableCareSummary(approvedPayload);
      expect(now.text).toBe(printable.text);
      expect(Buffer.from(now.text, "utf8").equals(Buffer.from(printable.text, "utf8"))).toBe(true);
      expect([now.hash, now.byteLength]).toEqual([PINNED[locale].artifactHash, PINNED[locale].byteLength]);
      expect([printable.hash, printable.byteLength]).toEqual([PINNED[locale].artifactHash, PINNED[locale].byteLength]);
      // No notice, notice heading or 11c.1 wording is added to an old artifact; nothing was mutated.
      expect(now.text).not.toContain(AI_LANGUAGE_COPY.careDraftNotices.draft[locale]);
      expect(now.text).not.toContain(getMessages(locale).careSummary.draftNotices.label);
      expect(JSON.stringify(approvedPayload)).toBe(before);
    });
  }

  it("keeps the old zh limitation wording stored in an old snapshot while new snapshots use 您 (D4)", async () => {
    const old = printableCareSummary(fixture["zh-SG"].approvedPayload).text;
    expect(old).toContain(LEGACY_9C1.zhSelectedOnly);
    const fresh = printableCareSummary((await renderDeterministicCareSummary(draft("zh-SG"))).payload).text;
    expect(fresh).toContain("此摘要仅包含您所选择的记录和问题。");
    expect(fresh).not.toContain(LEGACY_9C1.zhSelectedOnly);
  });

  for (const locale of ["en-SG", "zh-SG"] as const) {
    it(`proves the test-only 9c.1 stand-in: the 11c.1 rendering minus its notices, at 9c.1 versions, equals the 9c.1 output (${locale})`, async () => {
      const current = await renderDeterministicCareSummary(draft(locale));
      const legacy = await asLegacy9c1Payload(current.payload);
      const { approvedPayload } = fixture[locale];
      expect({ ...legacy, status: "APPROVED", patientApproval: approvedPayload.patientApproval }).toEqual(approvedPayload);
      // Only the notice section (and, in zh-SG, the D4 limitation wording) separates new content from old.
      const extra = current.payload.sections.filter((section) => !approvedPayload.sections.some((old) => old.sectionId === section.sectionId));
      expect(extra.map((section) => section.sectionId)).toEqual(["CARE_DRAFT_NOTICES"]);
      expect(current.contentHash).not.toBe(approvedPayload.rendering.contentHash);
    });
  }

  it("round-trips a 9c.1 snapshot through the stored-revision codec (Packet 10 backup and restore row validation) unchanged", () => {
    const payload = fixture["en-SG"].approvedPayload;
    const revision = {
      schemaVersion: 1,
      recordType: "CARE_SUMMARY_SNAPSHOT" as const,
      recordId: id(50),
      revisionId: id(51),
      revisionNumber: 3,
      previousRevisionId: id(52),
      action: "UPDATE" as const,
      recordedAt: "2026-10-04T02:00:00.000Z",
      revisionCreatedAt: "2026-10-04T02:05:00.000Z",
      temporal: { kind: "ATEMPORAL" as const },
      provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" },
      auditEventId: id(53),
      transactionId: id(54),
      payload,
    };
    const row = careSummarySnapshotRevisionCodec.create(revision as never);
    const read = careSummarySnapshotRevisionCodec.validateAfterRead(JSON.parse(JSON.stringify(row)));
    expect(JSON.stringify(read.revision.payload)).toBe(JSON.stringify(payload));
  });
});

/**
 * Packet 11C Addendum C, Task C4 (D3, D4; owner: "old snapshots byte-identical"): approved 11c.1 artifacts stay byte-identical after the
 * AI marking (renderer and template 11c.2) is introduced, and new deterministic previews stay byte-identical to the 11c.1 output.
 *
 * The fixture `fixtures/care-summary-11c1-approved.json` was captured by running the UNCHANGED 11c.1 code (renderer, AI replacement
 * projection and `printableCareSummary`, before any C4 edit) and approving the result:
 * - `deterministic`: `renderDeterministicCareSummary(draft(locale))` (the same draft as the 9c.1 fixture);
 * - `aiAssisted`: `projectValidatedAiCareSummary` of `syntheticCareDraft("ORDINARY", locale)` from an accepted fake-provider composition
 *   (`acceptedAiCareComposition` with the evaluation `shellCandidate`), i.e. an 11c.1 AI-assisted snapshot made before C4.
 * Its file SHA-256 is pinned here; the 9c.1 fixture above is unchanged.
 */
const FIXTURE_11C1_PATH = join(process.cwd(), "src/application/care-preparation/fixtures/care-summary-11c1-approved.json");
const FIXTURE_11C1_SHA256 = "be2ce2a2658badd9b9d7467ab6295a19fd5f42894b45c2215b3a3a6a6feb75a3";
const PINNED_11C1 = {
  deterministic: {
    "en-SG": { contentHash: "c5ef21ed928144e9d83c277d612dc369fd881676b0cf5bdd6f145ccd25102cb3", artifactHash: "11eabb30b5f4b3a9ed9415019956566cabcd8b44e057c8437c9a073ba8bea2ce", byteLength: 901 },
    "zh-SG": { contentHash: "e3e8e6271192ec576123d3c474803ac40fcd63ba7245a345d9f7dbfdeabd7f81", artifactHash: "3bad1a3ce35e40a4c7687563dd13fe1d79dc8ec4a14930eb590481d3185bdf2d", byteLength: 868 },
  },
  aiAssisted: {
    "en-SG": { contentHash: "c809ac558a882d6ac25f4a6102c518e7c82fecb1850dd6d5324261ae6421ed77", artifactHash: "a7890d3d1d6ff4115bbfdca34b28b8b4ab1f206954489374018c5eceeffa5c9b", byteLength: 669 },
    "zh-SG": { contentHash: "0847d011a8a0d88a4d34c237071e741c01e75e7b9b2c52fcee4171587469379d", artifactHash: "9b2e463cd4a5ab9d57c28ef44f3b80332e0b53eb73d302544239e40e8d9f5d87", byteLength: 643 },
  },
} as const;
const fixture11c1Bytes = readFileSync(FIXTURE_11C1_PATH);
const fixture11c1 = JSON.parse(fixture11c1Bytes.toString("utf8")) as Record<"deterministic" | "aiAssisted", Record<"en-SG" | "zh-SG", FixtureEntry>>;

/**
 * Deterministic previews before C4 (captured from the unchanged 11c.1 renderer): sha256 of the stored payload JSON, the content hash and
 * the printable artifact hash of every synthetic draft shape and locale.
 */
const DETERMINISTIC_BEFORE_C4 = {
  "ORDINARY en-SG": ["7167372df5338ca453f22acded7801028f580b9c5f0874c7fe4cf5e3cf8e24dc", "b1240ec9b7545f98cd64a0846a6610b992af7411038068429a905c18ffc83b48", "a1f14797d7248493eb487ab8e1fa20570dceb7f00aea7ddf18ebb01018a8e519"],
  "ORDINARY zh-SG": ["8c9045fab43b46a740b7d28939d515ef171ed193732eeb2a7d4564b5fdcb0160", "8fca4946eee67086e4e2112c568948ca9d6f73f927b01ce4c3fa7de8a638cbb0", "54dc548e6859dc085c692ca2bbac0b846396d7b0a3bd558668c13e5d92318ef3"],
  "MISSING_DATA en-SG": ["4bf6d23f927cda382a5a97c70afac99972bef8c17302752604679f3d5ad9057d", "2be7cf4d214aea16e8954863cf958cfa0a80c4ac93bcd54b2e9adffad8f41f78", "97c355e44efd0e534aa3db6077129b306f3cf60d20f17ccb22f0adba9d719631"],
  "MISSING_DATA zh-SG": ["a02814d9e13a2f46aa17a4f46252a93d3ad878ab9e6740a9565e01f739e55a2d", "81d6c4b1fd3d56b6204b6ae53ec1c6dc77dcd0a2c56d5621910700b6db8f4fbf", "cee1bc2ac0cbe8ad823e4a93997d8f91389bcd90569ada80fb72e3cc6ff968ac"],
  "HIDDEN_LIMITATION en-SG": ["8d07e5a0c8251711b213eef3036d15774df173ca05390885f781d15b608f50e5", "0b58e8ecada1168a45bf42b00b8db3b6ec705036dbef32486122fbb17dc61c9b", "e9fd0153f89673501fd2bc797faadd657b22009758d53ac5a499eafc67af1078"],
  "HIDDEN_LIMITATION zh-SG": ["df9215ae68c973685ac8af1d7589b1846b00f140a706d1a119ff53d27175b39c", "095afba723ae1769e9a7c606b0ecff77a6e7c912afe3c787e8d1444c0643a7f8", "498121ee46a14993dfbd85c97fdb4c7a4a1648a127aa5726714d1aef4e6aaba5"],
  "RICH en-SG": ["b38dd52dcde9eea8b4e06de48dbde97eb50ba9a6297d9b1c1ac565fbf6b90d0d", "5271d07e9a88a6c2c3765d956ca5226b8c3452d2f727768cd8a84379b8b6802a", "44f6961cefca7e2e51a1911953aae64ee4bc7162261ee696f98a958bff5f8977"],
  "RICH zh-SG": ["60f884d7c77433f46117681a8761de6652a3e10d711dbe8382f26e800fde252c", "b268b7ec468539da44ba2d554273645c274f17df51cdb8b7c16e7cb77d1313a4", "0b0bd54a33f2adf91d084e2a24c00a16a51e4f2d7c30e7865e2e8978579ffb2e"],
} as const;

describe("Packet 11C C4: 11c.1 approved artifacts and deterministic previews stay byte-identical", () => {
  it("uses the 11c.1 fixture exactly as captured from the unchanged 11c.1 code path", () => {
    expect(createHash("sha256").update(fixture11c1Bytes).digest("hex")).toBe(FIXTURE_11C1_SHA256);
    for (const kind of ["deterministic", "aiAssisted"] as const) {
      for (const locale of ["en-SG", "zh-SG"] as const) {
        const { approvedPayload } = fixture11c1[kind][locale];
        expect([approvedPayload.composition.method, approvedPayload.composition.templateVersion, approvedPayload.rendering.rendererVersion, approvedPayload.rendering.localePackVersion]).toEqual([
          kind === "deterministic" ? "DETERMINISTIC" : "AI_ASSISTED",
          "care-summary-template.11c.1",
          "care-summary-renderer.11c.1",
          "care-summary-locale.11c.1",
        ]);
        expect([approvedPayload.status, approvedPayload.rendering.contentHash]).toEqual(["APPROVED", PINNED_11C1[kind][locale].contentHash]);
        // Made before C4: no marking section.
        expect(approvedPayload.sections.map((section) => section.sectionId)).not.toContain("AI_MARKING");
      }
    }
  });

  for (const kind of ["deterministic", "aiAssisted"] as const) {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      it(`${kind} ${locale}: still validates unchanged, keeps its stored hash, prints the same bytes and round-trips the stored-revision codec`, async () => {
        const { approvedPayload, printable } = fixture11c1[kind][locale];
        const before = JSON.stringify(approvedPayload);
        const parsed = careSummarySnapshotPayloadSchema.safeParse(approvedPayload);
        expect(parsed.success && JSON.stringify(parsed.data)).toBe(before);
        const recomputed = await hashCanonicalJson(careSummaryExportProjection({ ...approvedPayload, rendererVersion: approvedPayload.rendering.rendererVersion, localePackVersion: approvedPayload.rendering.localePackVersion }));
        expect(recomputed).toBe(PINNED_11C1[kind][locale].contentHash);
        const now = printableCareSummary(approvedPayload);
        expect(Buffer.from(now.text, "utf8").equals(Buffer.from(printable.text, "utf8"))).toBe(true);
        expect([now.hash, now.byteLength]).toEqual([PINNED_11C1[kind][locale].artifactHash, PINNED_11C1[kind][locale].byteLength]);
        expect([printable.hash, printable.byteLength]).toEqual([PINNED_11C1[kind][locale].artifactHash, PINNED_11C1[kind][locale].byteLength]);
        // No marking is added to an old artifact.
        expect(now.text).not.toContain(getMessages(locale).ai.demoTag);
        expect(now.text).not.toContain(getMessages(locale).ai.resultCheck);
        // Packet 10 backup and restore row validation (the stored-revision codec) keeps it unchanged.
        const revision = {
          schemaVersion: 1,
          recordType: "CARE_SUMMARY_SNAPSHOT" as const,
          recordId: id(60),
          revisionId: id(61),
          revisionNumber: 3,
          previousRevisionId: id(62),
          action: "UPDATE" as const,
          recordedAt: "2026-10-04T02:00:00.000Z",
          revisionCreatedAt: "2026-10-04T02:10:00.000Z",
          temporal: { kind: "ATEMPORAL" as const },
          provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" },
          auditEventId: id(63),
          transactionId: id(64),
          payload: approvedPayload,
        };
        const row = careSummarySnapshotRevisionCodec.create(revision as never);
        expect(JSON.stringify(careSummarySnapshotRevisionCodec.validateAfterRead(JSON.parse(JSON.stringify(row))).revision.payload)).toBe(before);
        expect(JSON.stringify(approvedPayload)).toBe(before);
      });
    }
  }

  it.each(["en-SG", "zh-SG"] as const)("%s: a new deterministic preview of the same draft is byte-identical to the approved 11c.1 content (no marking)", async (locale) => {
    const fresh = await renderDeterministicCareSummary(draft(locale));
    const { approvedPayload } = fixture11c1.deterministic[locale];
    expect(JSON.stringify({ ...fresh.payload, status: "APPROVED", patientApproval: approvedPayload.patientApproval })).toBe(JSON.stringify(approvedPayload));
    expect(fresh.contentHash).toBe(PINNED_11C1.deterministic[locale].contentHash);
    expect(printableCareSummary(fresh.payload).hash).toBe(PINNED_11C1.deterministic[locale].artifactHash);
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: proves the test-only 11c.1 AI-assisted stand-in: an 11c.2 replacement minus its marking, at 11c.1 versions, equals the pre-C4 output", async (locale) => {
    const current = (await renderDeterministicCareSummary(syntheticCareDraft("ORDINARY", locale))).payload;
    const { composition } = await acceptedAiCareComposition(current, { candidate: shellCandidate });
    const next = await projectValidatedAiCareSummary({ current, composition, auditRef: AI_AUDIT_REF, validatedAt: AI_VALIDATED_AT });
    const legacy = await asLegacy11c1AiAssistedPayload(next);
    const { approvedPayload } = fixture11c1.aiAssisted[locale];
    expect({ ...legacy, status: "APPROVED", patientApproval: approvedPayload.patientApproval }).toEqual(approvedPayload);
    // Only the marking section (and the 11c.2 versions, so the content hash) separates the new AI-assisted content from the old.
    const extra = next.sections.filter((section) => !approvedPayload.sections.some((old) => old.sectionId === section.sectionId));
    expect(extra.map((section) => section.sectionId)).toEqual(["AI_MARKING"]);
    expect(next.rendering.contentHash).not.toBe(approvedPayload.rendering.contentHash);
  });

  it("every synthetic deterministic preview shape stays byte-identical to its pre-C4 output (payload, content hash, artifact)", async () => {
    const now: Record<string, readonly string[]> = {};
    for (const shape of ["ORDINARY", "MISSING_DATA", "HIDDEN_LIMITATION", "RICH"] as const) {
      for (const locale of ["en-SG", "zh-SG"] as const) {
        const rendered = await renderDeterministicCareSummary(syntheticCareDraft(shape, locale));
        now[`${shape} ${locale}`] = [createHash("sha256").update(JSON.stringify(rendered.payload), "utf8").digest("hex"), rendered.contentHash, printableCareSummary(rendered.payload).hash];
        expect(rendered.payload.sections.map((section) => section.sectionId)).not.toContain("AI_MARKING");
        expect([rendered.payload.composition.templateVersion, rendered.payload.rendering.rendererVersion]).toEqual(["care-summary-template.11c.1", "care-summary-renderer.11c.1"]);
      }
    }
    expect(now).toEqual(DETERMINISTIC_BEFORE_C4);
  });
});

/**
 * Packet 11C Addendum B, Task B1b (carried B1a review minor, test-only): every locale-pack string a 9c.1 artifact can render is pinned
 * to its 9c.1 value, so a future edit cannot silently change an old approved artifact. `printableCareSummary` renders the title from
 * `shared.appName` and each section heading from the CURRENT pack by the stored `titleLocaleAssetId`; every other line is stored block
 * text. The 9c.1 values are the committed Packet 9C messages (HEAD before Packet 11C B1a). The Symptoms, Patterns and Safety headings
 * had no asset in 9c.1 (a 9c.1 snapshot can never hold those sections) and still have none: none may be invented for them. Strings a
 * 9c.1 snapshot stores in its blocks (purpose labels, group titles, the appointment notes and the limitation texts) are pinned too, as
 * the values its stored text was rendered from; only `selectedOnly` (zh, D4) differs now, and old snapshots keep their stored 你 text.
 */
describe("9c.1 artifact strings stay pinned (Packet 11C B1b)", () => {
  const HEADINGS_9C1 = {
    "en-SG": {
      "care-summary.title": "Preview my summary",
      "care-summary.scope": "Summary scope",
      "care-summary.section.scope": "Summary scope",
      "care-summary.section.care-plan": "Current recorded care plan",
      "care-summary.section.organisation": "Care organisation",
      "care-summary.section.measurements": "Recorded measurements",
      "care-summary.section.medication": "Medication records",
      "care-summary.section.intake-activity": "Meals and activity",
      "care-summary.section.questions": "Questions for my care team",
      "care-summary.section.limitations": "About this summary",
    },
    "zh-SG": {
      "care-summary.title": "预览我的摘要",
      "care-summary.scope": "摘要范围",
      "care-summary.section.scope": "摘要范围",
      "care-summary.section.care-plan": "当前记录的护理计划",
      "care-summary.section.organisation": "护理安排",
      "care-summary.section.measurements": "测量记录",
      "care-summary.section.medication": "用药记录",
      "care-summary.section.intake-activity": "饮食与活动",
      "care-summary.section.questions": "给护理团队的问题",
      "care-summary.section.limitations": "关于此摘要",
    },
  } as const;
  const STORED_9C1 = {
    "en-SG": {
      appName: "JagaOn",
      purposeAppointment: "For my appointment: Demo clinic",
      purposeRoutine: "For a routine review",
      periodLine: "Records from Demo range",
      preparedOn: "Prepared on Demo time",
      timeNotRecorded: "Time not recorded",
      approximately: "about 9:00 am",
      groupTitles: { GLUCOSE: "Glucose readings", INSULIN: "Insulin records", MEALS: "Meal notes", WALKS: "Walks" },
      appointmentEnteredByYou: "Appointment entered by you",
      appointmentUnverified: "Details not verified by the clinic",
      limitations: {
        "care-summary.limitation.selected-only": "This summary contains only the records and questions you selected.",
        "care-summary.limitation.patient-reported": "Patient-reported information; not externally verified.",
        "care-summary.limitation.missing": "Missing or unrecorded information may not appear here.",
      },
    },
    "zh-SG": {
      appName: "JagaOn",
      purposeAppointment: "为我的预约准备：Demo clinic",
      purposeRoutine: "用于例行复查",
      periodLine: "记录期间：Demo range",
      preparedOn: "制作于 Demo time",
      timeNotRecorded: "未记录时间",
      approximately: "约 9:00 am",
      groupTitles: { GLUCOSE: "血糖读数", INSULIN: "胰岛素记录", MEALS: "饮食笔记", WALKS: "散步" },
      appointmentEnteredByYou: "预约由你输入",
      appointmentUnverified: "资料未经诊所核实",
      limitations: {
        "care-summary.limitation.selected-only": LEGACY_9C1.zhSelectedOnly,
        "care-summary.limitation.patient-reported": "由使用者自行报告；未经外部核实。",
        "care-summary.limitation.missing": "缺失或未记录的资料可能不会显示在这里。",
      },
    },
  } as const;

  it.each(["en-SG", "zh-SG"] as const)("%s: the title and every section heading a 9c.1 artifact renders equal their 9c.1 values", (locale) => {
    const pack = careSummaryLocalePack(locale);
    for (const [assetId, text] of Object.entries(HEADINGS_9C1[locale])) expect(pack.asset(assetId), assetId).toBe(text);
    expect(getMessages(locale).shared.appName).toBe(STORED_9C1[locale].appName);
    // Every section a 9c.1 snapshot can hold resolves to exactly these headings; Symptoms, Patterns and Safety have no heading asset.
    for (const sectionId of CARE_SUMMARY_SECTION_ORDER) {
      const assetId = sectionAssetId(sectionId);
      if (sectionId === "SYMPTOMS_AND_CONTEXT" || sectionId === "PATTERNS" || sectionId === "SAFETY_HISTORY") expect(() => pack.asset(assetId), sectionId).toThrow("SUMMARY_LOCALE_INVALID");
      else expect(pack.asset(assetId), sectionId).toBe(HEADINGS_9C1[locale][assetId as keyof (typeof HEADINGS_9C1)[typeof locale]]);
    }
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: the strings a 9c.1 snapshot's stored text was rendered from are unchanged (zh selectedOnly only, D4)", (locale) => {
    const pack = careSummaryLocalePack(locale);
    const expected = STORED_9C1[locale];
    expect(pack.summary.purposeAppointment("Demo clinic")).toBe(expected.purposeAppointment);
    expect(pack.summary.purposeRoutine).toBe(expected.purposeRoutine);
    expect(pack.summary.periodLine("Demo range")).toBe(expected.periodLine);
    expect(pack.summary.preparedOn("Demo time")).toBe(expected.preparedOn);
    expect(pack.summary.timeNotRecorded).toBe(expected.timeNotRecorded);
    expect(pack.summary.approximately("9:00 am")).toBe(expected.approximately);
    expect(pack.groupTitles).toEqual(expected.groupTitles);
    expect([pack.appointmentEnteredByYou, pack.appointmentUnverified]).toEqual([expected.appointmentEnteredByYou, expected.appointmentUnverified]);
    for (const [assetId, text] of Object.entries(expected.limitations)) {
      if (locale === "zh-SG" && assetId === "care-summary.limitation.selected-only") expect(pack.asset(assetId)).toBe(text.replace("你", "您"));
      else expect(pack.asset(assetId), assetId).toBe(text);
    }
    // The 9c.1 fixture's own printed text carries exactly these headings and stored strings.
    const printed = fixture[locale].printable.text;
    for (const assetId of ["care-summary.section.scope", "care-summary.section.organisation", "care-summary.section.measurements", "care-summary.section.questions", "care-summary.section.limitations"] as const) {
      expect(printed).toContain(`## ${HEADINGS_9C1[locale][assetId]}`);
    }
    expect(printed).toContain(expected.limitations["care-summary.limitation.selected-only"]);
  });
});
