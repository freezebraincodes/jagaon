import type { NextConfig } from "next";

/**
 * Packet 12 D4 (owner decision 2026-10-09): minimum hackathon response headers.
 * Browser sources: same origin; OneMap tiles and the required OneMap attribution logo (images, www.onemap.gov.sg); TRTC signalling
 * hosts exactly as documented in internal-docs/implementation-plans/13-dependency-and-live-test-preflight.md §1.3 (CSP row).
 * OneMap search (/api/onemap/search) and DeepSeek (/api/ai/shell) are reached only through same-origin routes, so neither host is
 * in the browser policy. `'unsafe-inline'` for scripts covers the App Router's inline bootstrap scripts without a nonce proxy;
 * `'unsafe-eval'` is added only under `next dev`, never in a production build.
 */
const isDevelopment = process.env.NODE_ENV === "development";

const TRTC_CONNECT_SOURCES = [
  "https://*.rtc-web.com",
  "wss://*.rtc-web.com",
  "https://*.rtc-web.io",
  "wss://*.rtc-web.io",
  "https://apisgp.my-imcloud.com",
  "wss://apisgp.my-imcloud.com",
];

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Owner decision 2026-10-09: `data:` for images only, for Leaflet's built-in tile-cancellation placeholder (no other directive).
  "img-src 'self' data: https://www.onemap.gov.sg",
  `connect-src 'self' ${TRTC_CONNECT_SOURCES.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Owner-approved Tencent build-time exclusion (2026-10-11). `JAGAON_BUILD_EXCLUDE_TRTC=1` when running `next build` (Turbopack in this
 * Next 16 setup; the webpack alias below covers `next build --webpack`):
 * - the TRTC Web SDK root and its RealtimeTranscriber plugin are aliased to local stubs, so no Tencent SDK code is bundled;
 * - `JAGAON_TRTC_EXCLUDED` is inlined as "1" into every bundle (src/config/build-exclusions.ts), so the server never enables TRTC and
 *   the client never loads or offers it, whatever the run-time settings say.
 * Without the switch the build is unchanged (no alias; the constant is "0"). This is not a licence clearance.
 */
const excludeTrtc = process.env.JAGAON_BUILD_EXCLUDE_TRTC === "1";
const TRTC_ALIASES = Object.freeze({
  "trtc-sdk-v5": "./src/voice/trtc/excluded/trtc-sdk-stub.ts",
  "trtc-sdk-v5/plugins/realtime-transcriber": "./src/voice/trtc/excluded/realtime-transcriber-stub.ts",
});

const nextConfig: NextConfig = {
  env: { JAGAON_TRTC_EXCLUDED: excludeTrtc ? "1" : "0" },
  ...(excludeTrtc
    ? {
        turbopack: { resolveAlias: { ...TRTC_ALIASES } },
        webpack: (config: { resolve?: { alias?: Record<string, unknown> } }) => {
          const absolute = Object.fromEntries(Object.entries(TRTC_ALIASES).map(([name, target]) => [`${name}$`, `${process.cwd()}/${target.slice(2)}`]));
          config.resolve = { ...config.resolve, alias: { ...(config.resolve?.alias ?? {}), ...absolute } };
          return config;
        },
      }
    : {}),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self), payment=(), usb=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
