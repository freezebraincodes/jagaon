/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

describe("Home page", () => {
  it("renders the JagaOn heading and foundation status", () => {
    render(<Home />);

    const heading = screen.getByRole("heading", { level: 1, name: "JagaOn" });
    const status = screen.getByText("Project foundation is running");

    expect(heading).toBeInTheDocument();
    expect(status).toBeInTheDocument();
  });
});
