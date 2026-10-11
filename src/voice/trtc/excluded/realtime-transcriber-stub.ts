/**
 * Owner-approved Tencent build-time exclusion (2026-10-11): the stand-in for the TRTC RealtimeTranscriber plugin module in a build made
 * with `JAGAON_BUILD_EXCLUDE_TRTC=1` (aliased by next.config.ts). It contains no Tencent code and is never started: the stubbed SDK
 * root reports "not supported" first.
 */
export class RealtimeTranscriber {}
