import type { Metadata } from "next";
// Keen Slider's base rules load first so the app's wheel styles can refine them.
import "keen-slider/keen-slider.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "JagaOn | Your Everyday Care Companion",
  description: "Synthetic-data hackathon prototype. Not for patient use.",
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
