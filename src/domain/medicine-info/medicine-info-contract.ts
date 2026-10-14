import { z } from "zod";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the AI contract of one general-medicine-information
 * request. Pure and browser-safe; the server route, the browser client and the validator share it.
 *
 * The request carries ONLY the medicine name she sees in her records (never her directions, readings, name, dates or record IDs; the
 * strict schema refuses any other field). The name is 1–60 characters of letters, digits, spaces, hyphens, periods and parentheses,
 * trimmed, with at least one letter.
 *
 * The model answers either OK with general information (what the medicine is generally used for and how it is generally taken, two
 * short sentences each) or NOT_FOUND (not a medicine, or a name it does not know). It never gives doses, amounts, instructions,
 * diagnoses or treatment advice; the validator (medicine-info-validator.1) enforces this on every answer.
 */
export const MEDICINE_INFO_TASK = "MEDICINE_GENERAL_INFO" as const;
export const MEDICINE_INFO_CONTRACT_VERSION = "medicine-info-contract.1";
export const MEDICINE_INFO_NAME_MAX_CHARS = 60;
/** Generous parse cap for each model text (the validator then applies the 20–300 character rule with its own reason). */
export const MEDICINE_INFO_TEXT_PARSE_MAX_CHARS = 600;

/** Letters (any script), digits, spaces, hyphens, periods and parentheses only. */
const NAME_CHARACTERS = /^[\p{L}\p{M}\p{N} .()-]+$/u;
const HAS_LETTER = /\p{L}/u;

/** True for a name the request may carry (and the UI may offer the AI button for). */
export function isMedicineInfoName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= MEDICINE_INFO_NAME_MAX_CHARS &&
    name === name.trim() &&
    !/\s{2,}/.test(name) &&
    NAME_CHARACTERS.test(name) &&
    HAS_LETTER.test(name)
  );
}

/** The request form of a name as she sees it: trimmed, inner whitespace collapsed (null when it still fails the name rule). */
export function toMedicineInfoName(raw: string): string | null {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return isMedicineInfoName(name) ? name : null;
}

/** The cache and notice key of a name: lower case, trimmed, inner whitespace collapsed. */
export function normaliseMedicineInfoName(raw: string): string {
  return (typeof raw === "string" ? raw : "").trim().replace(/\s+/g, " ").toLowerCase();
}

const nameSchema = z.string().refine(isMedicineInfoName, { message: "NAME_INVALID" });

export const medicineInfoRequestSchema = z.strictObject({
  task: z.literal(MEDICINE_INFO_TASK),
  medicineName: nameSchema,
});
export type MedicineInfoRequest = z.infer<typeof medicineInfoRequestSchema>;

export const MEDICINE_INFO_REPLY_KINDS = Object.freeze(["OK", "NOT_FOUND"] as const);
export type MedicineInfoReplyKind = (typeof MEDICINE_INFO_REPLY_KINDS)[number];

const text = z.string().min(1).max(MEDICINE_INFO_TEXT_PARSE_MAX_CHARS).nullable();

/**
 * The strict model reply. Kind rules:
 * - OK: `name`, `usedFor` and `howGenerallyTaken` non-null; `genericName` optional (null when the name is already the generic name or
 *   unknown).
 * - NOT_FOUND: every other field null.
 */
export const medicineInfoReplySchema = z
  .strictObject({
    kind: z.enum(MEDICINE_INFO_REPLY_KINDS),
    name: text,
    genericName: text,
    usedFor: text,
    howGenerallyTaken: text,
  })
  .superRefine((reply, context) => {
    const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (reply.kind === "NOT_FOUND") {
      if (reply.name !== null || reply.genericName !== null || reply.usedFor !== null || reply.howGenerallyTaken !== null) issue("NOT_FOUND_CARRIES_TEXT");
      return;
    }
    if (reply.name === null || reply.usedFor === null || reply.howGenerallyTaken === null) issue("OK_MISSING_TEXT");
  });
export type MedicineInfoReply = z.infer<typeof medicineInfoReplySchema>;

/** The validated general information shown on the card. `name` is always the requested name (the model never renames it). */
export type MedicineGeneralInfo = Readonly<{
  name: string;
  genericName: string | null;
  usedFor: string;
  howGenerallyTaken: string;
}>;

export const medicineGeneralInfoSchema = z.strictObject({
  name: nameSchema,
  genericName: nameSchema.nullable(),
  usedFor: z.string().min(1).max(MEDICINE_INFO_TEXT_PARSE_MAX_CHARS),
  howGenerallyTaken: z.string().min(1).max(MEDICINE_INFO_TEXT_PARSE_MAX_CHARS),
});

/** The strict JSON Schema handed to the provider (`text.format`), mirroring `medicineInfoReplySchema` (kind rules are the validator's). */
export function medicineInfoReplyJsonSchema(): Record<string, unknown> {
  const nullableText = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "name", "genericName", "usedFor", "howGenerallyTaken"],
    properties: {
      kind: { type: "string", enum: [...MEDICINE_INFO_REPLY_KINDS] },
      name: nullableText,
      genericName: nullableText,
      usedFor: nullableText,
      howGenerallyTaken: nullableText,
    },
  };
}
