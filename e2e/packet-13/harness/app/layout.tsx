import type { Metadata } from "next";
// The production layout's stylesheets, in the same order (src/app/layout.tsx), so layout evidence matches the shipped CSS.
import "keen-slider/keen-slider.min.css";
import "../../../../src/app/globals.css";

export const metadata: Metadata = {
  title: "JagaOn Packet 13 voice harness (TEST-ONLY)",
  description: "Isolated test harness. Synthetic data only. Not for patient use.",
  robots: { index: false, follow: false },
};

export default function HarnessLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
