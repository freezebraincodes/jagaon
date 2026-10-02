/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Home from "@/app/page";

describe("Home page", () => {
  afterEach(() => {
    cleanup();
    // jsdom may not expose localStorage here; the app treats that as unavailable.
    window.localStorage?.clear();
  });

  it("opens the Packet 6A first-run Welcome when no demo setup is saved", async () => {
    render(<Home />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome to JagaOn" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start demo setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the prepared demo profile" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("shows the English demo boundary notice", async () => {
    render(<Home />);
    expect(
      await screen.findByText("Hackathon demo. Synthetic data only. Not for patient use."),
    ).toBeInTheDocument();
  });

  it("shows the Chinese demo boundary notice", async () => {
    render(<Home />);
    expect(await screen.findByText("黑客松演示。仅使用模拟资料。不供病患使用。")).toBeInTheDocument();
  });

  it("does not contain prohibited HSA-status claims", async () => {
    const { container } = render(<Home />);
    await screen.findByRole("heading", { level: 1 });
    const text = container.textContent ?? "";
    expect(text).not.toContain("HSA compliant");
    expect(text).not.toContain("HSA approved");
    expect(text).not.toContain("HSA registered");
  });
});
