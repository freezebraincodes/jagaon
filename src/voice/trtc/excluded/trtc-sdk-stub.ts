/**
 * Owner-approved Tencent build-time exclusion (2026-10-11): the stand-in for the TRTC Web SDK root module in a build made with
 * `JAGAON_BUILD_EXCLUDE_TRTC=1` (next.config.ts aliases the package here). It contains no Tencent code. If anything ever reached it,
 * the TRTC adapter's support check answers "not supported", so the adapter ends with UNSUPPORTED_BROWSER before any credential
 * request, room or microphone (a clean unavailable path, never a crash). The app itself never offers TRTC in such a build.
 */
const TRTC_EXCLUDED_STUB = Object.freeze({
  isSupported: async () => Object.freeze({ result: false, detail: Object.freeze({ excludedAtBuild: true }) }),
});

export default TRTC_EXCLUDED_STUB;
