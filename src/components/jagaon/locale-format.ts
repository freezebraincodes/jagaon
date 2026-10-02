import type { SupportedLocale } from "@/i18n/types";

/**
 * Locale-aware punctuation for composing two approved strings, so zh-SG
 * uses full-width marks instead of ASCII ones. No copy is added here.
 */

export function labelWithAside(locale: SupportedLocale, label: string, aside: string): string {
  return locale === "zh-SG" ? `${label}（${aside}）` : `${label} (${aside})`;
}

export function labelAndValue(locale: SupportedLocale, label: string, value: string): string {
  return locale === "zh-SG" ? `${label}：${value}` : `${label}: ${value}`;
}
