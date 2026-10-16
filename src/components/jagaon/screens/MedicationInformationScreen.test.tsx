import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { getMessages } from "@/i18n/get-messages";
import { MedicationInformationScreen } from "./MedicationInformationScreen";

afterEach(() => cleanup());

describe("MedicationInformationScreen", () => {
  it("keeps reviewed information and recorded directions in labelled regions for each medicine", () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");

    render(
      <MedicationInformationScreen
        messages={messages}
        locale="en-SG"
        fixture={fixture}
        goBack={vi.fn()}
      />,
    );

    for (const prescription of fixture.recordedPrescriptions) {
      const medicine = screen.getByRole("article", {
        name: prescription.displayName,
      });
      const reviewed = within(medicine).getByRole("region", {
        name: messages.medication.reviewedTag,
      });
      const recorded = within(medicine).getByRole("region", {
        name: messages.medication.recordedHeading,
      });

      // Each leaflet carries its own review date: glargine 2026-10-02, glulisine (Apidra) 2026-10-14.
      const reviewedDate = prescription.medicationId === "insulin-glulisine" ? "2026-10-14" : "2026-10-02";
      expect(reviewed).toHaveTextContent(messages.shared.reviewedOn(reviewedDate));
      expect(within(reviewed).getByRole("link", { name: `${messages.shared.source}: HealthHub` }))
        .toHaveAttribute("href", expect.stringContaining("healthhub.sg"));
      expect(recorded).toHaveTextContent(prescription.recordedDirection!);
      // Recorded directions never appear inside the reviewed region, and vice versa.
      expect(reviewed).not.toHaveTextContent(prescription.recordedDirection!);
      expect(recorded).not.toHaveTextContent(messages.medication.glarginePurpose);
    }
  });

  it("preserves recorded directions verbatim when the locale changes", () => {
    const fixture = createDemoScenarioFixture();
    const { rerender } = render(
      <MedicationInformationScreen
        messages={getMessages("en-SG")}
        locale="en-SG"
        fixture={fixture}
        goBack={vi.fn()}
      />,
    );

    rerender(
      <MedicationInformationScreen
        messages={getMessages("zh-SG")}
        locale="zh-SG"
        fixture={fixture}
        goBack={vi.fn()}
      />,
    );

    for (const prescription of fixture.recordedPrescriptions) {
      expect(screen.getByText(prescription.recordedDirection!)).toBeInTheDocument();
    }
  });

  it("uses the approved unavailable fallback without source metadata for unknown content", () => {
    const source = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    const fixture = {
      ...source,
      recordedPrescriptions: [
        {
          ...source.recordedPrescriptions[0],
          medicationId: "unreviewed-synthetic-medicine",
          displayName: "Unreviewed synthetic medicine",
          hasReviewedInfo: false,
        },
      ],
    };

    render(
      <MedicationInformationScreen
        messages={messages}
        locale="en-SG"
        fixture={fixture}
        goBack={vi.fn()}
      />,
    );

    const medicine = screen.getByRole("article", {
      name: "Unreviewed synthetic medicine",
    });
    const reviewed = within(medicine).getByRole("region", {
      name: messages.medication.reviewedTag,
    });
    expect(reviewed).toHaveTextContent(messages.medication.infoUnavailable);
    expect(
      within(reviewed).queryByText(messages.shared.reviewedOn("2026-10-02")),
    ).not.toBeInTheDocument();
    expect(within(reviewed).queryByRole("link")).not.toBeInTheDocument();
  });
  it("lists recorded facts with provenance, separate from reviewed information", () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    render(
      <MedicationInformationScreen messages={messages} locale="en-SG" fixture={fixture} goBack={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: messages.medication.screenTitle })).toBeInTheDocument();

    for (const rx of fixture.recordedPrescriptions) {
      const medicine = screen.getByRole("article", { name: rx.displayName });
      const recorded = within(medicine).getByRole("region", { name: messages.medication.recordedHeading });
      for (const value of [rx.form, rx.amountText, rx.timingText, rx.effectiveDate, rx.recordedDirection]) {
        expect(within(recorded).getByText(value!)).toBeInTheDocument();
      }
      expect(recorded).toHaveTextContent(
        rx.source === "PRESCRIPTION_LABEL"
          ? messages.onboarding.sourcePrescriptionLabel
          : messages.onboarding.sourceCareTeam,
      );
      // Recorded directions never appear inside the reviewed panel.
      const reviewed = within(medicine).getByRole("region", { name: messages.medication.reviewedTag });
      expect(reviewed).not.toHaveTextContent(rx.amountText!);
      expect(reviewed).not.toHaveTextContent(rx.recordedDirection!);
    }
  });

  it("keeps the person's actions as questions and a disabled later-packet action", () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    render(
      <MedicationInformationScreen messages={messages} locale="en-SG" fixture={fixture} goBack={vi.fn()} />,
    );
    const medicine = screen.getByRole("article", { name: fixture.recordedPrescriptions[0]!.displayName });
    const actions = within(medicine).getByRole("region", { name: messages.medication.actionsTag });
    expect(actions).toHaveTextContent(messages.medication.sampleQuestionLabel);
    expect(actions).toHaveTextContent(messages.medication.askPurpose);
    const add = within(actions).getByRole("button", { name: messages.medication.addQuestion });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(messages.today.futureFeature);
    const history = within(actions).getByText(messages.medication.sourceHistory).closest("details")!;
    expect(history).toHaveTextContent("HealthHub");
    expect(history).toHaveTextContent(messages.onboarding.sourcePrescriptionLabel);
    expect(screen.getByText(messages.medication.generalLimit)).toBeInTheDocument();
  });
  it("adds her own question for the doctor or pharmacist to Prepare for my appointment (owner decision 2026-10-14)", async () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    const addCareQuestion = vi.fn(async (_text: string) => true);
    render(<MedicationInformationScreen messages={messages} locale="en-SG" fixture={fixture} goBack={vi.fn()} addCareQuestion={addCareQuestion} />);
    const medicine = screen.getByRole("article", { name: fixture.recordedPrescriptions[0]!.displayName });
    const actions = within(medicine).getByRole("region", { name: messages.medication.actionsTag });
    const add = within(actions).getByRole("button", { name: messages.medication.addQuestion });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAccessibleDescription(messages.today.futureFeature);
    fireEvent.click(add);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(messages.carePreparation.questionLabel), { target: { value: "  Can I take this before my walk?  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: messages.shared.save }));
    await waitFor(() => expect(addCareQuestion).toHaveBeenCalledWith("Can I take this before my walk?"));
    expect(await within(actions).findByText(messages.medication.questionAdded)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the question dialog open and reports a failed save", async () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    render(<MedicationInformationScreen messages={messages} locale="en-SG" fixture={fixture} goBack={vi.fn()} addCareQuestion={vi.fn(async () => false)} />);
    const medicine = screen.getByRole("article", { name: fixture.recordedPrescriptions[0]!.displayName });
    fireEvent.click(within(medicine).getByRole("button", { name: messages.medication.addQuestion }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(messages.carePreparation.questionLabel), { target: { value: "Is this the right pen?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: messages.shared.save }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByText(messages.medication.questionAdded)).toBeNull();
  });

  it("shows unknown setup facts as unknown and no reviewed content for free text", () => {
    const source = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    const fixture = {
      ...source,
      recordedPrescriptions: [
        {
          ...source.recordedPrescriptions[0]!,
          medicationId: "demo-medicine:55555555-5555-4555-8555-555555555555",
          displayName: "Oxatril (demo)",
          genericName: null,
          form: null,
          amountText: null,
          timingText: null,
          effectiveDate: null,
          recordedDirection: null,
          source: "UNKNOWN" as const,
          hasReviewedInfo: false,
        },
      ],
    };
    render(<MedicationInformationScreen messages={messages} locale="en-SG" fixture={fixture} goBack={vi.fn()} />);
    const medicine = screen.getByRole("article", { name: "Oxatril (demo)" });
    const recorded = within(medicine).getByRole("region", { name: messages.medication.recordedHeading });
    expect(within(recorded).getAllByText(messages.onboarding.unknownValue).length).toBeGreaterThanOrEqual(5);
    const reviewed = within(medicine).getByRole("region", { name: messages.medication.reviewedTag });
    expect(reviewed).toHaveTextContent(messages.medication.infoUnavailable);
    expect(within(reviewed).queryByRole("link")).not.toBeInTheDocument();
  });
});
