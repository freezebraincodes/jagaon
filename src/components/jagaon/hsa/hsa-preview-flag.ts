/**
 * Owner decision 2026-10-16: the build-time HSA preview flag. `NEXT_PUBLIC_JAGAON_HSA_PREVIEW=off` (exact value) is a public release:
 * no HSA-bounded mode switch, always bounded. Unset or anything else shows the switch in More → Settings. Not a secret: Next inlines
 * the value into the browser bundle at build time, so a change needs a rebuild. Read here only; `hsa-build-flags.ts` interprets it.
 */
export const HSA_PREVIEW_FLAG: string | undefined = process.env.NEXT_PUBLIC_JAGAON_HSA_PREVIEW;
