import { sha256Hex } from "@/application/intelligence/metrics";
import { CARE_SUMMARY_AI_MARKING_SECTION, type CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { getMessages } from "@/i18n/get-messages";
import { careSummaryLocalePack } from "./care-summary-locale-pack";

/**
 * The printable document artifact for one approved snapshot (domain 11.8).
 *
 * Its lines are generated only from the snapshot's sections, blocks and
 * reviewed locale assets, so the embedded content corresponds exactly to
 * the approved projection. The artifact hash covers these exact UTF-8
 * bytes; it can differ from the snapshot content hash.
 */

export type PrintableLine =
  | { kind: "TITLE"; text: string }
  | { kind: "HEADING"; text: string }
  | { kind: "LABEL"; text: string }
  | { kind: "TEXT"; text: string }
  | { kind: "QUESTION"; text: string; language: "en-SG" | "zh-SG" | "und" };

export type PrintableCareSummary = { lines: PrintableLine[]; text: string; hash: string; byteLength: number };

export function printableCareSummary(payload: CareSummarySnapshotPayload): PrintableCareSummary {
  const pack = careSummaryLocalePack(payload.locale);
  const lines: PrintableLine[] = [{ kind: "TITLE", text: getMessages(payload.locale).shared.appName }];
  for (const section of payload.sections) {
    if (section.sectionId === CARE_SUMMARY_AI_MARKING_SECTION) {
      // Packet 11C Addendum C, C4 (renderer 11c.2): the AI marking prints its own stored, hashed rows: the approved tag as the section
      // heading, the approved check line beneath it. Only an AI-assisted 11c.2 snapshot has this section, so no older artifact changes.
      // Placement and appearance: human acceptance pending.
      for (const block of section.blocks) {
        if (block.kind !== "AI_MARKING") continue;
        const [tag, ...rest] = block.renderedText.split("\n");
        lines.push({ kind: "HEADING", text: tag ?? "" });
        for (const text of rest) lines.push({ kind: "TEXT", text });
      }
      continue;
    }
    lines.push({ kind: "HEADING", text: pack.asset(section.titleLocaleAssetId) });
    for (const block of section.blocks) {
      if (block.kind === "PATIENT_QUESTION") lines.push({ kind: "QUESTION", text: block.originalPatientText.text, language: block.originalPatientText.language });
      else {
        const [first, ...rest] = block.renderedText.split("\n");
        // A recorded-fact group opens with its reviewed group title.
        lines.push({ kind: block.kind === "RECORDED_FACT" && rest.length > 0 ? "LABEL" : "TEXT", text: first ?? "" });
        for (const text of rest) lines.push({ kind: "TEXT", text });
      }
    }
  }
  const text = lines.map((line) => (line.kind === "HEADING" ? `## ${line.text}` : line.kind === "QUESTION" ? `- ${line.text}` : line.text)).join("\n");
  return { lines, text, hash: sha256Hex(text), byteLength: new TextEncoder().encode(text).length };
}
