import { MEDICINE_INFO_DIRECTIONS_SENTENCE } from "./medicine-info-validator";
import type { MedicineInfoReply, MedicineInfoRequest } from "./medicine-info-contract";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the versioned system prompt `medicine-info-prompt.1` and
 * the builder of the provider message list. Pure data; no provider, endpoint or credential. The prompt SHAPES the answer from the
 * model's own general knowledge (nothing is fetched at run time); the validator (medicine-info-validator.1) ENFORCES it on every answer.
 *
 * The provider sees exactly two messages: this system prompt (with its few-shot examples) and one user message holding only
 * {"medicineName": ...}. Nothing else from the app (no directions, readings, her name, dates or record IDs) is ever part of either.
 */
export const MEDICINE_INFO_PROMPT_VERSION = "medicine-info-prompt.1";

export type MedicineInfoFewShot = Readonly<{
  title: string;
  medicineName: string;
  /** A rejection-worthy draft, shown only in the corrected example, with why it is wrong. */
  badDraft?: Readonly<{ reply: MedicineInfoReply; why: string }>;
  reply: MedicineInfoReply;
}>;

const NOT_FOUND: MedicineInfoReply = { kind: "NOT_FOUND", name: null, genericName: null, usedFor: null, howGenerallyTaken: null };

/** Each good reply passes the validator (pinned by a test). */
export const MEDICINE_INFO_FEW_SHOTS: readonly MedicineInfoFewShot[] = Object.freeze([
  {
    title: "A known diabetes medicine: two short general sentences each, the fixed closing sentence",
    medicineName: "Metformin",
    reply: {
      kind: "OK",
      name: "Metformin",
      genericName: "metformin",
      usedFor: "Metformin is a medicine used to help control blood sugar in people with type 2 diabetes. It is often one of the first medicines used for this.",
      howGenerallyTaken: `It is generally taken by mouth with or after meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`,
    },
  },
  {
    title: "A brand name: give the generic name too",
    medicineName: "Lantus",
    reply: {
      kind: "OK",
      name: "Lantus",
      genericName: "insulin glargine",
      usedFor: "Lantus is a long-acting insulin used to help control blood sugar in people with diabetes. It works slowly over the day.",
      howGenerallyTaken: `It is generally injected under the skin with a pen at about the same time each day. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`,
    },
  },
  {
    title: "Corrected draft: no amounts, no counted frequency, no instructions, no claims",
    medicineName: "Gliclazide",
    badDraft: {
      reply: {
        kind: "OK",
        name: "Gliclazide",
        genericName: "gliclazide",
        usedFor: "Gliclazide cures diabetes by making you produce more insulin.",
        howGenerallyTaken: "Take 80 mg twice a day. Do not stop taking it without asking your doctor.",
      },
      why: "It claims a cure, gives an amount and a counted frequency, and gives instructions.",
    },
    reply: {
      kind: "OK",
      name: "Gliclazide",
      genericName: "gliclazide",
      usedFor: "Gliclazide is a medicine used to help control blood sugar in people with type 2 diabetes. It helps the body release more of its own insulin.",
      howGenerallyTaken: `It is generally taken by mouth, usually with a meal. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`,
    },
  },
  {
    title: "Not a medicine: NOT_FOUND",
    medicineName: "Chicken rice",
    reply: NOT_FOUND,
  },
  {
    title: "A name you do not know as a medicine: NOT_FOUND (never guess)",
    medicineName: "Glucotab",
    reply: NOT_FOUND,
  },
] satisfies MedicineInfoFewShot[]);

const json = (value: unknown) => JSON.stringify(value);

function fewShotText(): string {
  return MEDICINE_INFO_FEW_SHOTS.map((shot, index) => {
    const lines = [`Example ${index + 1}: ${shot.title}`, `Input: ${json({ medicineName: shot.medicineName })}`];
    if (shot.badDraft) lines.push(`Bad draft (rejected, never output this): ${json(shot.badDraft.reply)}`, `Why it is wrong: ${shot.badDraft.why}`);
    lines.push(`Output: ${json(shot.reply)}`);
    return lines.join("\n");
  }).join("\n\n");
}

/** The exact system prompt (medicine-info-prompt.1). */
export const MEDICINE_INFO_SYSTEM_PROMPT = [
  "ROLE",
  "You give general medicine information for a diabetes self-care diary. The person sees the name of a medicine in their own records and wants to know, in general terms, what it is generally used for and how it is generally taken. Use only your own general knowledge.",
  "",
  "HARD RULES",
  "- If the name is not a medicine, or you do not know it as a medicine, return NOT_FOUND. Never guess.",
  "- Never give doses, amounts, strengths or counted frequencies (no numbers with units, no \"twice a day\", no \"every 8 hours\").",
  "- Never tell the person to start, stop, change, skip, double, increase, reduce or adjust any medicine.",
  "- Never give advice of any kind (no \"you should\", \"try\", \"make sure\", \"do not\", \"avoid\").",
  "- Never diagnose or talk about the person's own health (no \"you have\", no \"diagnosis\"), and never claim a cure.",
  "- Plain English for an older adult. usedFor and howGenerallyTaken are each one or two short sentences (at most 300 characters).",
  `- howGenerallyTaken always ends with exactly: "${MEDICINE_INFO_DIRECTIONS_SENTENCE}"`,
  "- name is the medicine name as given; genericName is its generic name when you know it, else null.",
  "",
  "OUTPUT",
  "- Return strict JSON only, exactly these fields: {\"kind\": \"OK\" | \"NOT_FOUND\", \"name\": string | null, \"genericName\": string | null, \"usedFor\": string | null, \"howGenerallyTaken\": string | null}.",
  "- OK: name, usedFor and howGenerallyTaken are set.",
  "- NOT_FOUND: every other field is null.",
  "- No other text, no markdown, no extra fields.",
  "",
  "EXAMPLES",
  fewShotText(),
].join("\n");

export type MedicineInfoPromptMessage = Readonly<{ role: "system" | "user"; text: string }>;

/** The provider message list for one schema-validated request: the system prompt, then ONE user message holding only the name. */
export function buildMedicineInfoPromptMessages(request: MedicineInfoRequest): readonly MedicineInfoPromptMessage[] {
  return Object.freeze([Object.freeze({ role: "system" as const, text: MEDICINE_INFO_SYSTEM_PROMPT }), Object.freeze({ role: "user" as const, text: json({ medicineName: request.medicineName }) })]);
}
