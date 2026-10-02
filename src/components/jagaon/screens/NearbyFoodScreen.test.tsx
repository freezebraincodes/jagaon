import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNearbyFoodAdapter } from "@/application/governed/nearby-food-adapter";

type Adapter = ReturnType<typeof createNearbyFoodAdapter>;
import { getMessages } from "@/i18n/get-messages";
import { NearbyFoodScreen } from "./NearbyFoodScreen";

afterEach(() => cleanup());

function renderScreen(adapter = createNearbyFoodAdapter()) {
  const messages = getMessages("en-SG");
  const navigate = vi.fn();
  render(
    <NearbyFoodScreen
      messages={messages}
      locale="en-SG"
      adapter={adapter}
      goBack={vi.fn()}
      navigate={navigate}
    />,
  );
  return { adapter, messages, navigate };
}

describe("NearbyFoodScreen", () => {
  it("keeps location idle until the explicit location button is pressed", () => {
    const { adapter, messages } = renderScreen();

    expect(adapter.getState()).toEqual({ kind: "IDLE" });
    fireEvent.click(
      screen.getByRole("button", { name: messages.food.useCurrentLocation }),
    );
    expect(adapter.getState()).toEqual({ kind: "PRE_PERMISSION" });
    expect(screen.getByText(messages.food.prePermissionBody)).toBeInTheDocument();
  });

  it("moves focus to manual location after location permission is declined", () => {
    const { adapter, messages } = renderScreen();
    const manualInput = screen.getByLabelText(messages.food.locationLabel);

    fireEvent.click(
      screen.getByRole("button", { name: messages.food.useCurrentLocation }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.food.usePostalInstead }),
    );

    expect(adapter.getState()).toEqual({ kind: "PERMISSION_DENIED" });
    expect(manualInput).toHaveFocus();
    expect(screen.getByText(messages.food.permissionDeniedBody)).toBeInTheDocument();
  });

  it("switches between provider-neutral map and list results", () => {
    const { adapter, messages } = renderScreen();

    fireEvent.click(
      screen.getByRole("button", { name: messages.food.useCurrentLocation }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.shared.continue }),
    );

    expect(adapter.getState().kind).toBe("RESULTS_MAP");
    const map = screen.getByRole("region", { name: messages.food.viewMap });
    expect(within(map).getAllByRole("button")).toHaveLength(5);
    expect(screen.getByText(messages.food.syntheticMapAttribution)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: messages.food.viewList }));
    expect(adapter.getState().kind).toBe("RESULTS_LIST");
    expect(screen.queryByRole("region", { name: messages.food.viewMap })).not.toBeInTheDocument();
  });

  it("keeps directory facts free of ungoverned health badges", () => {
    const { messages } = renderScreen();
    fireEvent.change(screen.getByLabelText(messages.food.locationLabel), {
      target: { value: "Jelutong" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.food.searchAction }));

    expect(screen.getByText(messages.food.syntheticDirectorySource)).toBeInTheDocument();
    expect(screen.queryByText(/lower gi|healthier|hpb-listed/i)).not.toBeInTheDocument();
  });

  it("retains provider attribution in map failure and venue details states", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    const { messages } = renderScreen(adapter);

    fireEvent.click(
      screen.getByRole("button", { name: "View details: Kampong Jelutong Food Centre (demo)" }),
    );
    expect(screen.getByText(messages.food.syntheticMapAttribution)).toBeInTheDocument();
    expect(screen.getByText(messages.food.syntheticDirectorySource)).toBeInTheDocument();
  });

  it("keeps general information reachable when the directory is unavailable", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_DIRECTORY_UNAVAILABLE" });
    const { messages, navigate } = renderScreen(adapter);

    fireEvent.click(
      screen.getByRole("button", { name: messages.food.generalInfoAction }),
    );
    expect(navigate).toHaveBeenCalledWith("GENERAL_FOOD_INFORMATION");
  });
  it("gives every map marker an upright numeral and an equivalent list entry", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    const { messages } = renderScreen(adapter);

    const map = screen.getByRole("region", { name: messages.food.viewMap });
    const markers = within(map).getAllByRole("button");
    markers.forEach((marker, index) => {
      // The pin shape is a rotated pseudo-element; the numeral is its own
      // unrotated span and is part of the accessible name.
      expect(marker.querySelector(".provider-marker-number")).toHaveTextContent(String(index + 1));
      expect(marker.getAttribute("aria-label")).toMatch(new RegExp(`^${index + 1} `));
    });
    const list = screen.getByRole("list", { name: messages.food.resultsCount(markers.length) });
    expect(within(list).getAllByRole("listitem")).toHaveLength(markers.length);
    expect(screen.getByText(messages.food.resultsCount(markers.length))).toBeInTheDocument();
  });

  it("treats a 6-digit postal code as a manual location without geolocation or URL changes", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    const before = window.location.href;
    try {
      const { adapter, messages } = renderScreen();
      fireEvent.change(screen.getByLabelText(messages.food.locationLabel), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: messages.food.searchAction }));

      expect(adapter.getState().kind).toBe("RESULTS_LIST");
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(window.location.href).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("labels offline results with their snapshot date and keeps the list usable", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_OFFLINE" });
    const { messages } = renderScreen(adapter);

    expect(screen.getByText(messages.food.offlineTitle)).toBeInTheDocument();
    expect(screen.getByText(messages.food.offlineBody("2026-09-15"))).toBeInTheDocument();
    expect(screen.getByText(messages.food.syntheticDirectorySource)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: messages.food.resultsCount(5) })).getAllByRole("listitem"))
      .toHaveLength(5);
  });

  it("keeps general information reachable after location is declined and in venue details", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "DENY_GPS" });
    const { messages, navigate } = renderScreen(adapter);

    fireEvent.click(screen.getByRole("button", { name: messages.food.generalInfoAction }));
    expect(navigate).toHaveBeenCalledWith("GENERAL_FOOD_INFORMATION");
  });

  it("shows only fictional demo venues", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_OFFLINE" });
    const { messages } = renderScreen(adapter);
    const list = screen.getByRole("list", { name: messages.food.resultsCount(5) });
    for (const item of within(list).getAllByRole("listitem")) {
      expect(item).toHaveTextContent("(demo)");
      expect(item).toHaveTextContent("(synthetic)");
    }
  });
  it("filters results by the person's distance, cuisine and venue-type choices", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    const { messages } = renderScreen(adapter);

    const distance = screen.getByRole("group", { name: messages.food.distanceLabel });
    fireEvent.click(within(distance).getByRole("button", { name: messages.food.within("1 km") }));
    expect(within(distance).getByRole("button", { name: messages.food.within("1 km") })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("list", { name: messages.food.resultsCount(4) })).toBeInTheDocument();

    const cuisine = screen.getByRole("group", { name: messages.food.cuisineLabel });
    fireEvent.click(within(cuisine).getByRole("button", { name: messages.food.cuisineIndian }));
    const list = screen.getByRole("list", { name: messages.food.resultsCount(2) });
    const distances = within(list)
      .getAllByText(/^about /)
      .map((node) => Number(node.textContent!.replace(/\D/g, "")));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(screen.getByText(messages.food.sortedByDistance)).toBeInTheDocument();

    const venueType = screen.getByRole("group", { name: messages.food.venueTypeLabel });
    fireEvent.click(within(venueType).getByRole("button", { name: messages.food.venueMarket }));
    expect(screen.getByRole("list", { name: messages.food.resultsCount(1) })).toHaveTextContent(
      "Tanjong Seroja Market (demo)",
    );

    fireEvent.click(screen.getByRole("button", { name: messages.food.resetFilters }));
    expect(screen.getByRole("list", { name: messages.food.resultsCount(5) })).toBeInTheDocument();
    expect(within(cuisine).getByRole("button", { name: messages.food.cuisineAny })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("matches governed attribute filters only with governed evidence and never shows a badge", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    const { messages } = renderScreen(adapter);
    const attributes = screen.getByRole("group", { name: messages.food.attributesLabel });
    expect(attributes).toHaveTextContent(messages.food.hpbWording);
    fireEvent.click(within(attributes).getByRole("button", { name: messages.food.attrLowerSugar }));
    expect(screen.getByText(messages.food.noResultsTitle)).toBeInTheDocument();
    expect(screen.getByText(messages.food.attributesNote)).toBeInTheDocument();
    fireEvent.click(within(attributes).getByRole("button", { name: messages.food.attrLowerSugar }));
    const list = screen.getByRole("list", { name: messages.food.resultsCount(5) });
    expect(within(list).getAllByText(messages.food.noGovernedAttribute)).toHaveLength(5);
    expect(list.textContent).not.toMatch(/lower gi|healthier|hpb-listed|lower in|higher in/i);
  });

  it("separates provider facts, governed attributes and availability on every venue card", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_OFFLINE" });
    const { messages } = renderScreen(adapter);
    const list = screen.getByRole("list", { name: messages.food.resultsCount(5) });
    for (const card of within(list).getAllByRole("listitem")) {
      expect(card).toHaveTextContent(messages.food.providerFacts);
      expect(card).toHaveTextContent(messages.food.noGovernedAttribute);
      expect(card).toHaveTextContent(messages.food.checkAvailability);
      const directions = within(card).getByRole("button", { name: messages.food.openDirections });
      expect(directions).toHaveAttribute("aria-disabled", "true");
      expect(directions).toHaveAccessibleDescription(messages.food.directionsUnavailable);
    }
  });

  it.each([
    ["IDLE", () => undefined, (m: ReturnType<typeof getMessages>) => m.food.locationNote],
    ["PRE_PERMISSION", (a: Adapter) => a.dispatch({ kind: "REQUEST_GPS" }), (m: ReturnType<typeof getMessages>) => m.food.prePermissionBody],
    ["RESULTS_MAP", (a: Adapter) => { a.dispatch({ kind: "REQUEST_GPS" }); a.dispatch({ kind: "GRANT_GPS" }); }, (m: ReturnType<typeof getMessages>) => m.food.syntheticMapAttribution],
    ["RESULTS_LIST", (a: Adapter) => a.dispatch({ kind: "SEARCH_BY_TEXT", query: "123456" }), (m: ReturnType<typeof getMessages>) => m.food.syntheticDirectorySource],
    ["PERMISSION_DENIED", (a: Adapter) => { a.dispatch({ kind: "REQUEST_GPS" }); a.dispatch({ kind: "DENY_GPS" }); }, (m: ReturnType<typeof getMessages>) => m.food.permissionDeniedTitle],
    ["AMBIGUOUS", (a: Adapter) => a.dispatch({ kind: "SEARCH_BY_TEXT", query: "Bu" }), (m: ReturnType<typeof getMessages>) => m.food.ambiguousTitle],
    ["NO_RESULTS", (a: Adapter) => a.dispatch({ kind: "SEARCH_BY_TEXT", query: "zzzz" }), (m: ReturnType<typeof getMessages>) => m.food.noResultsTitle],
    ["MAP_UNAVAILABLE", (a: Adapter) => { a.dispatch({ kind: "REQUEST_GPS" }); a.dispatch({ kind: "GRANT_GPS" }); a.dispatch({ kind: "SIMULATE_MAP_UNAVAILABLE" }); }, (m: ReturnType<typeof getMessages>) => m.food.mapUnavailableTitle],
    ["DIRECTORY_UNAVAILABLE", (a: Adapter) => a.dispatch({ kind: "SIMULATE_DIRECTORY_UNAVAILABLE" }), (m: ReturnType<typeof getMessages>) => m.food.directoryUnavailableTitle],
    ["OFFLINE", (a: Adapter) => a.dispatch({ kind: "SIMULATE_OFFLINE" }), (m: ReturnType<typeof getMessages>) => m.food.offlineTitle],
    ["VENUE_DETAILS", (a: Adapter) => { a.dispatch({ kind: "REQUEST_GPS" }); a.dispatch({ kind: "GRANT_GPS" }); a.dispatch({ kind: "SELECT_VENUE", venueId: "venue-001" }); }, (m: ReturnType<typeof getMessages>) => m.food.detailsTitle],
  ] as const)("renders the %s state in both locales with general information reachable", (kind, arrange, text) => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const adapter = createNearbyFoodAdapter();
      arrange(adapter);
      expect(adapter.getState().kind).toBe(kind);
      const messages = getMessages(locale);
      render(
        <NearbyFoodScreen messages={messages} locale={locale} adapter={adapter} goBack={vi.fn()} navigate={vi.fn()} />,
      );
      expect(screen.getAllByText(text(messages)).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: messages.food.generalInfoAction })).toBeInTheDocument();
      expect(screen.getByText(messages.food.reviewedInfoUnavailable)).toBeInTheDocument();
      cleanup();
    }
  });
});
