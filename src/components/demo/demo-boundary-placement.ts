/**
 * Where the bilingual "Hackathon demo. Synthetic data only. Not for patient use." boundary banner appears.
 * Owner decision 2026-10-12: hidden on every screen to keep screen space. To show it again, change this one value:
 * - "WELCOME": only on the setup Welcome screen;
 * - "EVERY_SCREEN": on every screen (the earlier behaviour: the app shell, its status states and every setup step);
 * - "HIDDEN": nowhere.
 */
export type DemoBoundaryPlacement = "HIDDEN" | "WELCOME" | "EVERY_SCREEN";

export const DEMO_BOUNDARY_PLACEMENT: DemoBoundaryPlacement = "HIDDEN";
