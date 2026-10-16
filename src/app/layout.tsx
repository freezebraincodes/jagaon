import type { Metadata, Viewport } from "next";
// Keen Slider's base rules load first so the app's wheel styles can refine them.
import "keen-slider/keen-slider.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "JagaOn | Your Everyday Care Companion",
  description: "Synthetic-data hackathon prototype. Not for patient use.",
};

/**
 * iPhone (owner feedback 2026-10-14): `viewport-fit=cover` lets the page reach the screen edges, so `env(safe-area-inset-bottom)` is
 * reported and the bottom navigation can pad itself above the home indicator instead of floating with page content showing below it.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
