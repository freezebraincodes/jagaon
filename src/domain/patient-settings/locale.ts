import { z } from "zod";

// Canonical supported-locale contract.
// One source of truth for locale values used across the entire application.
export const SUPPORTED_LOCALES = ["en-SG", "zh-SG"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const supportedLocaleSchema = z.enum(SUPPORTED_LOCALES);