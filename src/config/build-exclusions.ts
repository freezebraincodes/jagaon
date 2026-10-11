/**
 * Owner-approved Tencent build-time exclusion (2026-10-11). `JAGAON_BUILD_EXCLUDE_TRTC=1` at BUILD time (read only by next.config.ts)
 * becomes the compile-time constant below through next.config `env` (`JAGAON_TRTC_EXCLUDED`, "1" or "0"), inlined into the browser and
 * server bundles, so no run-time setting can turn it back. In an excluded build the server treats TRTC as not enabled (whatever
 * `JAGAON_VOICE_PROVIDERS` says), the client never loads or offers TRTC, and the TRTC SDK packages are aliased to local stubs. This is
 * the one read of that build constant; it is not a secret. Outside a Next build (unit tests) it is undefined, i.e. not excluded.
 */
export const TRTC_EXCLUDED_AT_BUILD: boolean = process.env.JAGAON_TRTC_EXCLUDED === "1";
