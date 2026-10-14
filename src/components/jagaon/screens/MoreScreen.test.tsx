import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { HelpScreen } from "./HelpScreen";
import { MoreScreen } from "./MoreScreen";
import { MyNotesScreen } from "./MyNotesScreen";

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
      deleteAll={{ prepare: vi.fn(), confirm: vi.fn() }}
      onDatasetDeleted={vi.fn()}
    />,
  );
  return navigate;
}

describe("MoreScreen", () => {
  it("adds a distinct Data and backup destination", () => {
    const navigate = renderMore();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(messages.packet10.more.data) }));
    expect(navigate).toHaveBeenCalledWith("DATA_BACKUP");
  });

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
    // Language and whole-dataset deletion live on More itself, as in frame 12.
    expect(screen.getByRole("group", { name: messages.settings.language })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: messages.settings.english })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: messages.packet10.hub.deleteAll })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: messages.settings.resetAction })).not.toBeInTheDocument();
  });

  it("opens the Packet 9B health-check and visit-preparation screens", () => {
    const navigate = renderMore();
    fireEvent.click(screen.getByRole("button", { name: messages.more.healthChecks }));
    expect(navigate).toHaveBeenLastCalledWith("PREVENTIVE_CARE");
    fireEvent.click(screen.getByRole("button", { name: messages.more.prepareVisit }));
    expect(navigate).toHaveBeenLastCalledWith("CARE_PREPARATION");
    for (const label of [messages.more.healthChecks, messages.more.prepareVisit]) {
      expect(screen.getByRole("button", { name: label })).not.toHaveAttribute("aria-disabled");
    }
  });

  it("opens My notes in place of the Reminders placeholder, and hides the settings and destinations that do not exist yet (owner decision 2026-10-12)", () => {
    const navigate = renderMore();
    fireEvent.click(screen.getByRole("button", { name: messages.myNotes.title }));
    expect(navigate).toHaveBeenCalledWith("MY_NOTES");
    expect(screen.queryByRole("button", { name: messages.more.reminders })).toBeNull();
    expect(screen.queryByRole("group", { name: messages.more.exportApps })).toBeNull();
    expect(screen.queryByText(messages.more.exportApps)).toBeNull();
    expect(screen.queryByRole("group", { name: messages.more.textSize })).toBeNull();
    expect(screen.queryByRole("switch", { name: messages.more.extraContrast })).toBeNull();
    expect(screen.queryByText(messages.more.extraContrast)).toBeNull();
    // Nothing left on More is an inoperable placeholder.
    expect(document.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
  });

  it("My notes shows its title and an empty-state line in both locales, and stores nothing yet", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const localized = getMessages(locale);
      render(<MyNotesScreen messages={localized} />);
      expect(screen.getByRole("heading", { level: 1, name: localized.myNotes.title })).toBeInTheDocument();
      expect(screen.getByText(localized.myNotes.empty)).toBeInTheDocument();
      cleanup();
    }
    expect(getMessages("zh-SG").myNotes.title).toBe("我的笔记");
  });

  it("names Prepare for my appointment as Today does (owner decision 2026-10-12)", () => {
    renderMore();
    expect(screen.getByRole("button", { name: "Prepare for my appointment" })).toBeInTheDocument();
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

  it("owner decision 2026-10-14: lists emotional support lines (SOS, mindline) after the general contacts, with sources and check date", () => {
    render(<HelpScreen messages={messages} goBack={vi.fn()} />);

    const section = screen.getByRole("region", { name: "Emotional support (Singapore)" });
    const general = screen.getByRole("region", { name: messages.help.generalContacts });
    expect(general.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const expected = [
      ["SOS: call 1767", "tel:1767"],
      ["SOS: WhatsApp CareText 9151 1767", "https://wa.me/6591511767"],
      ["mindline: call 1771", "tel:1771"],
      ["mindline: WhatsApp 6669 1771", "https://wa.me/6566691771"],
    ] as const;
    for (const [name, href] of expected) expect(within(section).getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute("href", href);
    expect(within(section).getAllByText(/24 hours/)).toHaveLength(2);
    expect(within(section).getAllByText(/Round the clock/)).toHaveLength(2);
    expect(within(section).getByRole("link", { name: messages.help.sosWebsite })).toHaveAttribute("href", "https://www.sos.org.sg/");
    expect(within(section).getByRole("link", { name: messages.help.mindlineWebsite })).toHaveAttribute("href", "https://www.mindline.sg/");
    expect(within(section).getByText(new RegExp(messages.shared.reviewedOn("2026-10-14")))).toBeInTheDocument();
    // The retired IMH line is not listed.
    expect(screen.queryByText(/6389\s?2222/)).not.toBeInTheDocument();
  });
});
