import { z } from "zod";

export type ImplementedReleaseProfile = "HACKATHON_DEMO";

const releaseProfileSchema = z.literal("HACKATHON_DEMO");

export const CURRENT_RELEASE_PROFILE: ImplementedReleaseProfile =
  "HACKATHON_DEMO";

export function parseImplementedReleaseProfile(
  value: unknown,
): ImplementedReleaseProfile {
  return releaseProfileSchema.parse(value);
}
