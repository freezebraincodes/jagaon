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

const nextConfig: NextConfig = {
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
