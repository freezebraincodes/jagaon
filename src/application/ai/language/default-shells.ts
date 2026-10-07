import { slotToken, slotTokenMatcher, type ShellFieldPath, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";
import { composeObservationShell, OBSERVATION_PATH } from "./observation-composer";

/**
 * Packet 11B.6 deterministic default shells (spec Section 9.2): the approved wording used in private, offline
 * and unactivated modes and on every failure, around the identical atoms. Contains exactly the plan's tokens.
 * Observation ownership (2026-10-07): the EXPLAIN observation is the observation composer's variant 0 (the unchanged default
 * wording, byte-identical), so the deterministic fallback never uses an AI-path variant. Version unchanged (no text changed).
 * ai-shells-default.11b.7 (presentation correction P1, ai-language-copy.11b.8, owner instruction 2026-10-08, offline): the default
 * observation names supplied items as the person's own words and quotes each item; every other default shell is unchanged.
 */
export const AI_DEFAULT_SHELLS_VERSION = "ai-shells-default.11b.7";

/**
 * Verify that each field's text contains exactly its requiredSlots, each exactly once.
 * Throws DEFAULT_SHELL_TOKEN_MISMATCH if any field has missing, duplicate, or extra tokens.
 */
export function assertShellClosure(plan: SlotPlan, texts: ShellTexts): void {
  const matcher = slotTokenMatcher();
  for (const field of plan.fields) {
    const text = texts.get(field.path);
    if (text === undefined) throw new Error("DEFAULT_SHELL_TOKEN_MISMATCH");

    // Collect all tokens (including duplicates)
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      found.push(match[1]);
    }

    // Sort and compare arrays for exact multiset equality
    const foundSorted = found.sort();
    const requiredSorted = [...field.requiredSlots].sort();

    if (foundSorted.length !== requiredSorted.length ||
        !foundSorted.every((id, i) => id === requiredSorted[i])) {
      throw new Error("DEFAULT_SHELL_TOKEN_MISMATCH");
    }
  }
}

export function defaultShells(plan: SlotPlan, copy: LanguageCopy = AI_LANGUAGE_COPY): ShellTexts {
  const locale = plan.locale;
  const texts = new Map<ShellFieldPath, string>();
  if (plan.taskType === "EXPLAIN_PATTERN") {
    const templates = copy.explainDefaults[locale];
    const inField = (path: ShellFieldPath) => plan.slots.filter((slot) => slot.homeField === path);
    const meaning = inField("headline")[0];
    texts.set("headline", templates.headline.replace("{meaning}", meaning ? slotToken(meaning.slotId) : ""));
    // The deterministic fallback always uses the composer's variant 0 (the approved default wording).
    texts.set(OBSERVATION_PATH, composeObservationShell(plan, 0, copy));
    const count = inField("evidence")[0];
    texts.set("evidence", count ? templates.evidenceWithCount.replace("{count}", slotToken(count.slotId)) : templates.evidenceWithoutCount);
  } else {
    for (const section of plan.sections) {
      const intro = copy.careIntros[section.sectionId]?.[locale];
      if (intro === undefined) throw new Error("DEFAULT_SHELL_MISSING_INTRO");
      texts.set(section.introPath, intro);
      for (const path of section.bulletPaths) {
        const field = plan.fields.find((entry) => entry.path === path);
        if (!field) throw new Error("DEFAULT_SHELL_MISSING_FIELD");
        texts.set(path, field.requiredSlots.map(slotToken).join(copy.pairJoin[locale]));
      }
    }
  }

  // Verify closure: each field's text contains exactly its requiredSlots, each exactly once
  assertShellClosure(plan, texts as ShellTexts);

  return texts as ShellTexts;
}
