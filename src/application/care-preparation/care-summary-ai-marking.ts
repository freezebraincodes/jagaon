import type { SupportedLocale } from "@/domain/patient-settings/locale";
import {
  CARE_SUMMARY_AI_MARKING_BLOCK_ID,
  CARE_SUMMARY_AI_MARKING_SECTION,
  CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING,
  type CareSummarySection,
  type CareSummarySnapshotPayload,
} from "@/domain/care-preparation/care-summary-snapshot";
import { getMessages } from "@/i18n/get-messages";
import { sectionAssetId } from "./care-summary-locale-pack";

/**
 * Packet 11C Addendum C, Task C4: the AI marking of an AI-assisted care summary (renderer and template 11c.2).
 *
 * One AI_MARKING block in its own last section (after the care-draft notices), built ONLY from the two approved catalogue rows
 * (11-bilingual-copy-state-matrix.md Section 2, APPROVED_PACKET_11) in the snapshot's locale: `ai.demoTag`, a line feed, then
 * `ai.resultCheck`. It is block content, so the content hash covers it and approval binds the exact artifact that prints it. No other
 * wording is added. Deterministic snapshots never carry it. Placement (after the notices) and appearance (the tag printed as the
 * section heading, the check line beneath it): human acceptance pending.
 *
 * `careSummaryAiMarkingIssues` is the exact validator the domain cannot be (the catalogue is the application's): every snapshot under an
 * AI-marking template must end with exactly this section for its locale; the domain schema already refuses a marking anywhere else.
 */

export { CARE_SUMMARY_AI_MARKING_BLOCK_ID };

/** The section's title asset id. The marking prints its own stored rows (the tag as the heading), never a locale-pack asset. */
export const CARE_SUMMARY_AI_MARKING_TITLE_ASSET_ID = sectionAssetId(CARE_SUMMARY_AI_MARKING_SECTION);

/** The marking text: the approved tag, a line feed, the approved check line, in the locale. */
export function careSummaryAiMarkingText(locale: SupportedLocale): string {
  const ai = getMessages(locale).ai;
  return `${ai.demoTag}\n${ai.resultCheck}`;
}

/** The AI marking section at `displayOrder` (always the snapshot's last section). */
export function careSummaryAiMarkingSection(locale: SupportedLocale, displayOrder: number): CareSummarySection {
  return {
    sectionId: CARE_SUMMARY_AI_MARKING_SECTION,
    titleLocaleAssetId: CARE_SUMMARY_AI_MARKING_TITLE_ASSET_ID,
    displayOrder,
    blocks: [{ kind: "AI_MARKING", blockId: CARE_SUMMARY_AI_MARKING_BLOCK_ID, temporalRole: "NOT_APPLICABLE", renderedText: careSummaryAiMarkingText(locale) }],
  };
}

/**
 * The exact-marking rule. Under an AI-marking template the last section must be exactly the marking section for the snapshot's locale
 * and no other section may be one; under any other template no section may be one. Stable closed code.
 */
export function careSummaryAiMarkingIssues(payload: Pick<CareSummarySnapshotPayload, "locale" | "sections" | "composition">): ["SUMMARY_AI_MARKING_INVALID"] | [] {
  const sections = payload.sections;
  const marking = sections.filter((section) => section.sectionId === CARE_SUMMARY_AI_MARKING_SECTION);
  if (!CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING.includes(payload.composition.templateVersion)) return marking.length === 0 ? [] : ["SUMMARY_AI_MARKING_INVALID"];
  const last = sections[sections.length - 1];
  const expected = careSummaryAiMarkingSection(payload.locale, sections.length - 1);
  return marking.length === 1 && last !== undefined && sameSection(last, expected) ? [] : ["SUMMARY_AI_MARKING_INVALID"];
}

/** Field-by-field equality (independent of key order): exactly these keys and values, exactly one block. */
function sameSection(actual: CareSummarySection, expected: CareSummarySection): boolean {
  const keys = (value: object) => Object.keys(value).sort().join(",");
  const block = actual.blocks.length === 1 ? actual.blocks[0]! : null;
  const want = expected.blocks[0]!;
  return (
    keys(actual) === keys(expected) &&
    actual.sectionId === expected.sectionId &&
    actual.titleLocaleAssetId === expected.titleLocaleAssetId &&
    actual.displayOrder === expected.displayOrder &&
    block !== null &&
    keys(block) === keys(want) &&
    block.kind === want.kind &&
    block.blockId === want.blockId &&
    block.temporalRole === want.temporalRole &&
    "renderedText" in block &&
    "renderedText" in want &&
    block.renderedText === want.renderedText
  );
}
