import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { HelpScreen } from "./HelpScreen";
import { MoreScreen } from "./MoreScreen";

afterEach(() => cleanup());

const messages = getMessages("en-SG");

function renderMore(navigate = vi.fn()) {
  render(
    <MoreScreen
      messages={messages}
      navigate={navigate}
      locale="en-SG"
      setLocale={vi.fn()}
      persistLocale={vi.fn()}
      resetDemo={vi.fn()}
    />,
  );
  return navigate;
}

describe("MoreScreen", () => {
  it("offers only enabled Packet 6 destinations", () => {
    const navigate = renderMore();

    fireEvent.click(screen.getByRole("button", { name: messages.medication.screenTitle }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(messages.more.foodInformation) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(messages.more.helpInfo) }));

    expect(navigate.mock.calls.map(([screenId]) => screenId)).toEqual([
      "MY_MEDICINES",
      "NEARBY_FOOD",
      "HELP_INFORMATION",
    ]);
    // Language and reset live on More itself, as in frame 12.
    expect(screen.getByRole("group", { name: messages.settings.language })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: messages.settings.english })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: messages.settings.resetAction })).toBeInTheDocument();
  });

  it("shows later-packet destinations as disabled placeholders that do nothing", () => {
    const navigate = renderMore();
    for (const label of [messages.more.healthChecks, messages.more.prepareVisit, messages.more.reminders]) {
      const tile = screen.getByRole("button", { name: label });
      expect(tile).toHaveAttribute("aria-disabled", "true");
      expect(tile).toHaveAccessibleDescription(messages.today.futureFeature);
      fireEvent.click(tile);
    }
    expect(navigate).not.toHaveBeenCalled();

    const exportRow = screen.getByRole("group", { name: messages.more.exportApps });
    expect(exportRow).toHaveAttribute("aria-disabled", "true");
    expect(exportRow).toHaveTextContent(messages.shared.unavailable);

    const textSize = screen.getByRole("group", { name: messages.more.textSize });
    expect(textSize).toHaveAttribute("aria-disabled", "true");
    expect(within(textSize).getByRole("button", { name: messages.more.smallerText })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(textSize).getByRole("button", { name: messages.more.largerText })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const contrast = screen.getByRole("switch", { name: messages.more.extraContrast });
    expect(contrast).toHaveAttribute("aria-checked", "false");
    expect(contrast).toHaveAttribute("aria-disabled", "true");
  });

  it("states units and the demo boundary without changing them", () => {
    renderMore();
    expect(screen.getByRole("group", { name: messages.more.units })).toHaveTextContent(messages.glucose.unit);
    const about = screen.getByRole("list", { name: messages.more.aboutDemo });
    for (const text of [messages.more.syntheticBody, messages.more.storageBody, messages.more.boundaryBody]) {
      expect(about).toHaveTextContent(text);
    }
    expect(screen.queryByText(/weekly trends|appointments booked|reminder set/i)).not.toBeInTheDocument();
  });

  it("shows source-bound generic contacts without assessing the user", () => {
    render(<HelpScreen messages={messages} goBack={vi.fn()} />);

    expect(screen.getByText(messages.help.noAssessment)).toBeInTheDocument();
    const contacts = screen.getByRole("region", { name: messages.help.generalContacts });
    expect(within(contacts).getByRole("link", { name: new RegExp(messages.help.call995) })).toHaveAttribute(
      "href",
      "tel:995",
    );
    expect(within(contacts).getByRole("link", { name: new RegExp(messages.help.nurseFirst) })).toHaveAttribute(
      "href",
      "tel:62626262",
    );
    expect(
      within(contacts).getByRole("link", { name: new RegExp(messages.help.accessibleEmergency) }),
    ).toHaveAttribute("href", "sms:70995");
    expect(contacts).toHaveTextContent("SCDF");
    expect(screen.getByRole("link", { name: messages.help.verifyCurrent })).toHaveAttribute(
      "href",
      "https://www.scdf.gov.sg/home/about-scdf/emergency-medical-services",
    );
    expect(screen.getByText(new RegExp(messages.shared.reviewedOn("2026-10-02")))).toBeInTheDocument();
    // No reviewed public-information source exists yet: neutral fallback only.
    expect(screen.getByText(messages.help.publicInfoUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(/1777/)).not.toBeInTheDocument();
  });
});
