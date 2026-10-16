import { HSA_BOUNDED_DEFAULT_FLAG } from "./hsa-bounded-default-flag";
import { HSA_PREVIEW_FLAG } from "./hsa-preview-flag";

/**
 * Owner decision 2026-10-16: how the HSA-bounded mode behaves in a given deployment, from two build-time flags (each read in its own
 * module, the browser graph's only environment reads besides the developer-settings and build-exclusion flags):
 *
 * - the preview flag (`hsa-preview-flag.ts`) set to "off": a public release. There is no switch, the mode is always BOUNDED and a
 *   stored choice is ignored; this wins over the default below. Otherwise the switch is shown in More → Settings.
 * - the bounded-default flag (`hsa-bounded-default-flag.ts`) set to "off": a device with no stored choice starts in PREVIEW. This is
 *   the judges' and stakeholders' demo. Otherwise it starts BOUNDED.
 *
 * Each person's own choice stays in their browser (see `hsa-bounded-mode.tsx`); these flags only set where a device starts.
 */
export type HsaBuildFlags = Readonly<{
  /** False only in a public release: no switch, always bounded. */
  switchAvailable: boolean;
  /** Where a device with no stored choice starts. */
  boundedByDefault: boolean;
}>;

export function parseHsaBuildFlags(env: Readonly<{ preview?: string; boundedDefault?: string }>): HsaBuildFlags {
  const switchAvailable = env.preview !== "off";
  return Object.freeze({ switchAvailable, boundedByDefault: !switchAvailable || env.boundedDefault !== "off" });
}

export const HSA_BUILD_FLAGS: HsaBuildFlags = parseHsaBuildFlags({ preview: HSA_PREVIEW_FLAG, boundedDefault: HSA_BOUNDED_DEFAULT_FLAG });
