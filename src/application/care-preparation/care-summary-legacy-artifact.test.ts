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
import { LEGACY_9C1, asLegacy9c1Payload } from "./care-preparation-test-support";

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
