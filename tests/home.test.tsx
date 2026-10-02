/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Home from "@/app/page";

describe("Home page", () => {
  afterEach(() => cleanup());

  it("renders the Packet 6 Today experience", () => {
    render(<Home />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Hello, Alex",
    });
    const action = screen.getByRole("button", { name: "Record a reading" });

    expect(heading).toBeInTheDocument();
    expect(action).toBeInTheDocument();
  });

  it("shows the English demo boundary notice", () => {
    render(<Home />);
    expect(
      screen.getByText(
        "Hackathon demo. This prototype uses synthetic data only and is not for patient use.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the Chinese demo boundary notice", () => {
    render(<Home />);
    expect(
      screen.getByText(
        "黑客松演示版本。本原型只使用模拟资料，不可用于实际病患护理。",
      ),
    ).toBeInTheDocument();
  });

  it("does not contain prohibited HSA-status claims", () => {
    const { container } = render(<Home />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("HSA compliant");
    expect(text).not.toContain("HSA approved");
    expect(text).not.toContain("HSA registered");
  });
});
