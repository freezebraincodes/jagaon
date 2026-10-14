/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more): the closed list of note theme keys. Descriptive labels only, never causes or
 * diagnoses. Shared by personal notes (storage, My notes counts) and the feelings chat (AI theme tags, validated against this list).
 */
export const NOTE_THEME_KEYS = Object.freeze(["SLEEP", "HEALTH_OR_SUGAR", "MEDICINES", "FAMILY", "WORK", "MONEY", "FOOD", "MOOD", "OTHER"] as const);

export type NoteThemeKey = (typeof NOTE_THEME_KEYS)[number];

export const isNoteThemeKey = (value: unknown): value is NoteThemeKey => typeof value === "string" && (NOTE_THEME_KEYS as readonly string[]).includes(value);
