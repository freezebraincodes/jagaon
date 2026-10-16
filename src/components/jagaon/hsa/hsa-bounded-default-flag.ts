/**
 * Owner decision 2026-10-16: the build-time HSA-bounded default. `NEXT_PUBLIC_JAGAON_HSA_BOUNDED_DEFAULT=off` (exact value) makes a
 * device with no stored choice start in PREVIEW, for the judges' and stakeholders' demo. Unset or anything else starts BOUNDED. Not a
 * secret: Next inlines the value into the browser bundle at build time, so a change needs a rebuild. Read here only;
 * `hsa-build-flags.ts` interprets it.
 */
export const HSA_BOUNDED_DEFAULT_FLAG: string | undefined = process.env.NEXT_PUBLIC_JAGAON_HSA_BOUNDED_DEFAULT;
