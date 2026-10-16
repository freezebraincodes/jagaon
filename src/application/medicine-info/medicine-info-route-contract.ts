import { z } from "zod";
import { medicineGeneralInfoSchema } from "@/domain/medicine-info/medicine-info-contract";
import { MEDICINE_INFO_REJECTION_REASONS } from "@/domain/medicine-info/medicine-info-validator";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the response contract of POST /api/ai/medicine-info.
 * Browser-safe: no credential, prompt, provider, endpoint or network code; the route and the browser client share it.
 *
 * The request body is exactly one `medicineInfoRequestSchema` object ({ task, medicineName }). The response is one of:
 * - OK: the general information that passed the server's validator (medicine-info-validator.1); the browser validates it AGAIN.
 * - NOT_FOUND: the model did not know the name as a medicine.
 * - REJECTED: the validator rejected the model's answer; closed reason codes only, the answer never leaves the server.
 * - UNAVAILABLE: a closed reason, the same vocabulary as POST /api/ai/feelings: DISABLED (either switch off), NOT_CONFIGURED (no spend
 *   limit, credential or model), ORIGIN_REJECTED, ACCESS_DENIED, BAD_REQUEST, SPEND_CEILING_REACHED (this route's own daily limit) and
 *   OPERATIONAL_SPEND_LOCKED (the provider's balance, HTTP 402) — the two "AI credit used up" reasons the app maps to the credit-limit
 *   dialog — SPEND_LEDGER_UNAVAILABLE, RATE_LIMITED, UPSTREAM_ERROR, TIMEOUT and CANCELLED. OFFLINE is never sent by the route; the
 *   browser client uses it when the request could not reach the route.
 */
export const MEDICINE_INFO_ROUTE_PATH = "/api/ai/medicine-info";
/** A 60-character name (up to 4 UTF-8 bytes each) plus the JSON envelope stays far below it. */
export const MEDICINE_INFO_MAX_BODY_BYTES = 1_024;

export const MEDICINE_INFO_UNAVAILABLE_REASONS = Object.freeze([
  "NOT_CONFIGURED",
  "DISABLED",
  "ORIGIN_REJECTED",
  "ACCESS_DENIED",
  "BAD_REQUEST",
  "SPEND_CEILING_REACHED",
  "OPERATIONAL_SPEND_LOCKED",
  "SPEND_LEDGER_UNAVAILABLE",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "OFFLINE",
] as const);
export type MedicineInfoUnavailableReason = (typeof MEDICINE_INFO_UNAVAILABLE_REASONS)[number];

/** The reasons that mean the demo's AI credit is used up (the app's existing credit-limit dialog). */
const CREDIT_LIMIT_REASONS: ReadonlySet<string> = new Set<MedicineInfoUnavailableReason>(["SPEND_CEILING_REACHED", "OPERATIONAL_SPEND_LOCKED"]);
export const isMedicineInfoCreditLimit = (reason: string | null | undefined): boolean => typeof reason === "string" && CREDIT_LIMIT_REASONS.has(reason);

export const medicineInfoRouteResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("OK"), info: medicineGeneralInfoSchema }),
  z.strictObject({ kind: z.literal("NOT_FOUND") }),
  z.strictObject({ kind: z.literal("REJECTED"), reasons: z.array(z.enum(MEDICINE_INFO_REJECTION_REASONS)).min(1).max(MEDICINE_INFO_REJECTION_REASONS.length) }),
  z.strictObject({ kind: z.literal("UNAVAILABLE"), reason: z.enum(MEDICINE_INFO_UNAVAILABLE_REASONS) }),
]);
export type MedicineInfoRouteResponse = z.infer<typeof medicineInfoRouteResponseSchema>;
