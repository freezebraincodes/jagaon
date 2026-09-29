import { describe, it, expect, afterEach } from "vitest";
import { render, within, cleanup } from "@testing-library/react";
import { DemoBoundaryNotice } from "./DemoBoundaryNotice";

describe("DemoBoundaryNotice", () => {
  afterEach(() => cleanup());

  it("renders a labelled complementary region that is visible", () => {
    const { container } = render(<DemoBoundaryNotice />);
    const region = container.querySelector("aside");
    expect(region).not.toBeNull();
    expect(region!).toBeVisible();
    expect(region!.getAttribute("aria-label")).toBe(
      "Public demo boundary notice",
    );
  });

  it("contains the exact English notice once", () => {
    const { container } = render(<DemoBoundaryNotice />);
    const region = container.querySelector("aside")!;
    expect(
      within(region).getByText(
        "Hackathon demo. This prototype uses synthetic data only and is not for patient use.",
      ),
    ).toBeInTheDocument();
  });

  it("contains the exact Chinese notice once", () => {
    const { container } = render(<DemoBoundaryNotice />);
    const region = container.querySelector("aside")!;
    expect(
      within(region).getByText(
        "黑客松演示版本。本原型只使用模拟资料，不可用于实际病患护理。",
      ),
    ).toBeInTheDocument();
  });

  it("has no dismiss button", () => {
    const { container } = render(<DemoBoundaryNotice />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not contain prohibited HSA-status claims", () => {
    const { container } = render(<DemoBoundaryNotice />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("HSA compliant");
    expect(text).not.toContain("HSA approved");
    expect(text).not.toContain("HSA registered");
  });
});
