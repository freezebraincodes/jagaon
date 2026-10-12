import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { AppMessages } from "@/i18n/types";
import {
  NO_FOOD_FILTERS,
  type CurrentLocationOutcome,
  type LocationResolution,
  type NearbyFoodDiscoveryPort,
  type NearbyFoodPlace,
  type NearbyFoodResult,
} from "@/application/nearby-food/nearby-food-contracts";
import { createSyntheticNearbyFood, SYNTHETIC_ORIGIN } from "@/application/nearby-food/synthetic-nearby-food";
import { ONEMAP_TILE_DESCRIPTOR } from "@/application/nearby-food/browser-map-descriptor";
import { HPB_SNAPSHOT_DESCRIPTOR } from "@/application/nearby-food/hpb-venue-directory";
import { NearbyFoodScreen } from "./NearbyFoodScreen";

// The OneMap view loads Leaflet; here it is replaced by a probe that can report tile failure.
vi.mock("../nearby-food/OneMapView", () => ({
  OneMapView: ({ messages, onUnavailable, places }: { messages: AppMessages; onUnavailable: () => void; places: unknown[] }) => (
    <div role="region" aria-label={messages.food.viewMap}>
      <span>{`onemap:${places.length}`}</span>
      <button type="button" onClick={onUnavailable}>
        simulate-tile-failure
      </button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const en = getMessages("en-SG");

type PortOverrides = Partial<Omit<NearbyFoodDiscoveryPort, "profile">> & { profile?: NearbyFoodDiscoveryPort["profile"] };

function port(overrides: PortOverrides = {}) {
  const base = createSyntheticNearbyFood();
  const spies = {
    resolveManualLocation: vi.fn(overrides.resolveManualLocation ?? base.resolveManualLocation),
    acquireCurrentLocation: vi.fn(overrides.acquireCurrentLocation ?? base.acquireCurrentLocation),
    findNearby: vi.fn(overrides.findNearby ?? base.findNearby),
    findSyntheticFallback: vi.fn(overrides.findSyntheticFallback ?? base.findSyntheticFallback),
    isOnline: vi.fn(overrides.isOnline ?? base.isOnline),
  };
  return { profile: overrides.profile ?? base.profile, ...spies } satisfies NearbyFoodDiscoveryPort;
}

function show(discovery: NearbyFoodDiscoveryPort, locale: "en-SG" | "zh-SG" = "en-SG") {
  const messages = getMessages(locale);
  const navigate = vi.fn();
  const view = render(<NearbyFoodScreen messages={messages} locale={locale} discovery={discovery} goBack={vi.fn()} navigate={navigate} />);
  return { messages, navigate, view };
}

function search(text: string, messages = en) {
  fireEvent.change(screen.getByLabelText(messages.food.locationLabel), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: messages.food.searchAction }));
}

async function useGps(messages = en) {
  fireEvent.click(screen.getByRole("button", { name: messages.food.useCurrentLocation }));
  fireEvent.click(screen.getByRole("button", { name: messages.shared.continue }));
}

const hpbPlace = (id: string, name: string, distanceMetres: number, criteria: NearbyFoodPlace["governedAttributes"] = []): NearbyFoodPlace => ({
  id,
  name,
  address: `${distanceMetres} Demo Road Singapore 238859`,
  coordinates: { latitude: 1.3, longitude: 103.85 },
  distanceMetres,
  cuisineLabels: criteria.length > 0 ? ["Western"] : [],
  cuisineGroups: criteria.length > 0 ? ["WESTERN"] : [],
  venueType: null,
  venueSource: { kind: "GOVERNED_DATASET", datasetId: "d_2925c2ccf75d1c135c2d469e0de3cee6", snapshotVersion: "hpb-nearby-food.1" },
  governedAttributes: criteria,
  evidenceSource: criteria.length > 0 ? { kind: "GOVERNED_DATASET", datasetId: "d_c475b9170c08f90580f4041bffd51639", snapshotVersion: "hpb-nearby-food.1" } : null,
});

const HPB_RESULTS: NearbyFoodResult = {
  kind: "RESULTS",
  directory: HPB_SNAPSHOT_DESCRIPTOR,
  places: [
    hpbPlace("hpb-1", "Cafe One - Demo Mall", 120, [
      { vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA", criterion: "Higher in wholegrains and lower in calories" },
      { vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA", criterion: "No added sugar" },
    ]),
    hpbPlace("hpb-2", "Plain Eatery", 340),
  ],
};

const hybridProfile = { geocoder: "ONEMAP_WITH_SNAPSHOT_POSTAL" as const, map: ONEMAP_TILE_DESCRIPTOR, directory: "HPB_SNAPSHOT" as const };

describe("NearbyFoodScreen on the provider-neutral port", () => {
  it("offers only the cuisine and venue-type choices the directory can answer (owner decision 2026-10-12)", () => {
    const base = createSyntheticNearbyFood().profile;
    show(port({ profile: { ...base, filterOptions: { cuisineGroups: ["CHINESE", "WESTERN"], venueTypes: [] } } }));
    const cuisine = screen.getByRole("group", { name: en.food.cuisineLabel });
    expect(within(cuisine).getAllByRole("button").map((button) => button.textContent)).toEqual([en.food.cuisineAny, en.food.cuisineChinese, en.food.cuisineWestern]);
    expect(screen.queryByRole("group", { name: en.food.venueTypeLabel })).toBeNull();
    expect(screen.queryByText(en.food.venueHawker)).toBeNull();
    cleanup();
    // Without declared choices (the synthetic profile), every choice is offered.
    show(port());
    expect(within(screen.getByRole("group", { name: en.food.cuisineLabel })).getAllByRole("button")).toHaveLength(5);
    expect(within(screen.getByRole("group", { name: en.food.venueTypeLabel })).getAllByRole("button")).toHaveLength(5);
  });

  it("never asks for location before the person presses Continue", async () => {
    const discovery = port();
    show(discovery);
    expect(discovery.acquireCurrentLocation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.food.useCurrentLocation }));
    expect(screen.getByText(en.food.prePermissionBody)).toBeInTheDocument();
    expect(screen.getAllByText(en.food.locationNotSaved).length).toBeGreaterThan(0);
    expect(discovery.acquireCurrentLocation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
    await waitFor(() => expect(discovery.acquireCurrentLocation).toHaveBeenCalledTimes(1));
  });

  it("returns focus to manual search after decline, timeout or unavailable location", async () => {
    for (const [outcome, text] of [
      [null, en.food.permissionDeniedBody],
      [{ kind: "TIMEOUT" }, en.food.locationTimedOut],
      [{ kind: "UNAVAILABLE" }, en.food.locationUnavailable],
      [{ kind: "DENIED" }, en.food.permissionDeniedBody],
    ] as const) {
      const discovery = port({ acquireCurrentLocation: async () => (outcome ?? { kind: "DENIED" }) as CurrentLocationOutcome });
      show(discovery);
      fireEvent.click(screen.getByRole("button", { name: en.food.useCurrentLocation }));
      if (outcome === null) fireEvent.click(screen.getByRole("button", { name: en.food.usePostalInstead }));
      else fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getByLabelText(en.food.locationLabel)).toHaveFocus();
      cleanup();
    }
  });

  it("stops a pending location request when the screen closes", async () => {
    let seen: AbortSignal | undefined;
    const discovery = port({ acquireCurrentLocation: (signal) => ((seen = signal), new Promise<CurrentLocationOutcome>(() => {})) });
    const { view } = show(discovery);
    await useGps();
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    view.unmount();
    expect(seen!.aborted).toBe(true);
  });

  it("keeps working after a StrictMode remount (development double effects)", async () => {
    render(
      <StrictMode>
        <NearbyFoodScreen messages={en} locale="en-SG" discovery={port()} goBack={vi.fn()} navigate={vi.fn()} />
      </StrictMode>,
    );
    search("123456");
    expect(await screen.findByRole("list", { name: en.food.resultsCount(5) })).toBeInTheDocument();
  });

  it("shows GPS results on the map and an equivalent numbered list", async () => {
    show(port());
    await useGps();
    const map = await screen.findByRole("region", { name: en.food.viewMap });
    const markers = within(map).getAllByRole("button");
    expect(markers).toHaveLength(5);
    markers.forEach((marker, index) => expect(marker.getAttribute("aria-label")).toMatch(new RegExp(`^${index + 1} `)));
    expect(screen.getByText(en.food.syntheticMapAttribution)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: en.food.resultsCount(5) })).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: en.food.viewList }));
    expect(screen.queryByRole("region", { name: en.food.viewMap })).not.toBeInTheDocument();
  });

  it("treats a 6-digit postal code as manual location, sending only origin, radius and filters", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    const before = window.location.href;
    const discovery = port();
    show(discovery);
    search("123456");
    await screen.findByRole("list", { name: en.food.resultsCount(5) });
    expect(discovery.resolveManualLocation).toHaveBeenCalledWith("123456", expect.any(AbortSignal));
    const [request] = discovery.findNearby.mock.calls[0]!;
    expect(Object.keys(request).sort()).toEqual(["filters", "origin", "radiusMetres"]);
    expect(request).toEqual({ origin: SYNTHETIC_ORIGIN, radiusMetres: 2000, filters: NO_FOOD_FILTERS });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it("asks the person to choose between ambiguous locations, then searches the choice", async () => {
    const candidates = [
      { label: "1 BUGIS STREET SINGAPORE 111111", coordinates: { latitude: 1.30, longitude: 103.85 } },
      { label: "2 BUGIS JUNCTION SINGAPORE 222222", coordinates: { latitude: 1.31, longitude: 103.86 } },
    ];
    const discovery = port({ resolveManualLocation: async () => ({ kind: "AMBIGUOUS", candidates }) as LocationResolution });
    show(discovery);
    search("Bugis");
    expect(await screen.findByText(en.food.ambiguousBody("Bugis"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /2 BUGIS JUNCTION/ }));
    await waitFor(() => expect(discovery.findNearby).toHaveBeenCalledWith(expect.objectContaining({ origin: candidates[1]!.coordinates }), expect.any(AbortSignal)));
  });

  it("re-queries with the person's filter choices and shows no results honestly", async () => {
    const discovery = port();
    show(discovery);
    search("123456");
    await screen.findByRole("list", { name: en.food.resultsCount(5) });
    const distance = screen.getByRole("group", { name: en.food.distanceLabel });
    fireEvent.click(within(distance).getByRole("button", { name: en.food.within("500 m") }));
    await screen.findByRole("list", { name: en.food.resultsCount(2) });
    expect(discovery.findNearby).toHaveBeenLastCalledWith(
      { origin: SYNTHETIC_ORIGIN, radiusMetres: 2000, filters: { ...NO_FOOD_FILTERS, maxDistanceMetres: 500 } },
      expect.any(AbortSignal),
    );
    const attributes = screen.getByRole("group", { name: en.food.attributesLabel });
    fireEvent.click(within(attributes).getByRole("button", { name: en.food.attrLowerSugar }));
    expect(await screen.findByText(en.food.noResultsTitle)).toBeInTheDocument();
  });

  it("keeps the list, required attribution and failure copy when OneMap tiles fail", async () => {
    const discovery = port({ profile: hybridProfile, findNearby: async () => HPB_RESULTS });
    show(discovery);
    await useGps();
    const map = await screen.findByRole("region", { name: en.food.viewMap });
    expect(within(map).getByText("onemap:2")).toBeInTheDocument();
    fireEvent.click(within(map).getByRole("button", { name: "simulate-tile-failure" }));
    expect(screen.getByText(en.food.mapTilesUnavailable)).toBeInTheDocument();
    expect(screen.getByText(en.food.oneMapAttribution)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: en.food.viewMap })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: en.food.resultsCount(2) }).querySelectorAll(":scope > li")).toHaveLength(2);
  });

  it("shows exact HPB wording, its source and dataset date, and no badge for unmatched venues", async () => {
    show(port({ profile: hybridProfile, findNearby: async () => HPB_RESULTS }));
    search("238859");
    const list = await screen.findByRole("list", { name: en.food.resultsCount(2) });
    const [badged, plain] = [...list.querySelectorAll<HTMLElement>(":scope > li")];
    expect(within(badged!).getByText("Higher in wholegrains and lower in calories")).toBeInTheDocument();
    expect(within(badged!).getByText("No added sugar")).toBeInTheDocument();
    expect(badged).toHaveTextContent(en.food.hpbWording);
    expect(badged).toHaveTextContent(`${en.food.governedDatasetSource} · ${en.food.governedDatasetDate("2026-10-02")}`);
    expect(plain).not.toHaveTextContent(en.food.hpbWording);
    expect(plain).not.toHaveTextContent(en.food.noGovernedAttribute);
    expect(list.textContent).not.toMatch(/lower gi|low gi|glycaemic|best for/i);
    expect(screen.getByText(en.food.governedDatasetStale)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Singapore Open Data Licence version 1.0" })).toHaveAttribute("href", "https://data.gov.sg/open-data-licence");
    expect(screen.getByRole("link", { name: "Healthier Eateries" })).toHaveAttribute("href", "https://data.gov.sg/datasets/d_2925c2ccf75d1c135c2d469e0de3cee6/view");
  });

  it("reports missing live search honestly and shows only labelled synthetic demo places", async () => {
    const discovery = port({ profile: hybridProfile, resolveManualLocation: async () => ({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }) as LocationResolution });
    show(discovery);
    search("Toa Payoh");
    expect(await screen.findByText(en.food.liveGeocoderUnavailable)).toBeInTheDocument();
    expect(screen.getByText(en.food.syntheticFallbackActive)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: en.food.resultsCount(5) });
    for (const item of list.querySelectorAll<HTMLElement>(":scope > li")) {
      // Owner decision 2026-10-12: names carry no "(demo)" suffix; the "(synthetic)"
      // address still labels every fixture place.
      expect(item).toHaveTextContent("(synthetic)");
      expect(item).toHaveTextContent(en.food.noGovernedAttribute);
    }
    expect(screen.getByText(en.food.syntheticDirectorySource)).toBeInTheDocument();
    expect(discovery.findNearby).not.toHaveBeenCalled();
  });

  it("shows the directory as unavailable without inventing venues and keeps general information reachable", async () => {
    const discovery = port({ findNearby: async () => ({ kind: "UNAVAILABLE", reason: "SNAPSHOT_UNAVAILABLE" }) as NearbyFoodResult });
    const { navigate } = show(discovery);
    search("123456");
    expect(await screen.findByText(en.food.directoryUnavailableTitle)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /places found/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.food.generalInfoAction }));
    expect(navigate).toHaveBeenCalledWith("GENERAL_FOOD_INFORMATION");
  });

  it("labels offline results with the bundled dataset date", async () => {
    show(port({ profile: hybridProfile, findNearby: async () => HPB_RESULTS, isOnline: () => false }));
    search("238859");
    expect(await screen.findByText(en.food.offlineTitle)).toBeInTheDocument();
    expect(screen.getByText(en.food.offlineBody("2026-10-02"))).toBeInTheDocument();
    expect(screen.getByRole("list", { name: en.food.resultsCount(2) })).toBeInTheDocument();
  });

  it("opens venue details only after a deliberate selection and omits directions for real results", async () => {
    show(port({ profile: hybridProfile, findNearby: async () => HPB_RESULTS }));
    search("238859");
    await screen.findByRole("list", { name: en.food.resultsCount(2) });
    expect(screen.queryByRole("button", { name: en.food.openDirections })).not.toBeInTheDocument();
    expect(screen.queryByText(en.food.directionsUnavailable)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details: Cafe One - Demo Mall" }));
    const details = screen.getByRole("article");
    expect(within(details).getByRole("heading", { name: "Cafe One - Demo Mall" })).toBeInTheDocument();
    expect(within(details).getByText(en.food.checkAvailability)).toBeInTheDocument();
    expect(within(details).queryByText(en.food.directionsUnavailable)).not.toBeInTheDocument();
    expect(within(details).getByText(en.food.oneMapAttribution)).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: en.food.viewList }));
    expect(screen.getByRole("list", { name: en.food.resultsCount(2) })).toBeInTheDocument();
  });

  it("keeps the disabled directions control and synthetic wording only for synthetic places", async () => {
    show(port());
    search("123456");
    const list = await screen.findByRole("list", { name: en.food.resultsCount(5) });
    for (const card of list.querySelectorAll<HTMLElement>(":scope > li")) {
      const directions = within(card).getByRole("button", { name: en.food.openDirections });
      expect(directions).toHaveAttribute("aria-disabled", "true");
      expect(directions).toHaveAccessibleDescription(en.food.directionsUnavailable);
    }
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(en.food.viewDetails) })[0]!);
    expect(within(screen.getByRole("article")).getByText(en.food.directionsUnavailable)).toBeInTheDocument();
  });

  type Arrange = () => Promise<void> | void;
  const STATES: Array<[string, (m: AppMessages) => string, PortOverrides, (m: AppMessages) => Arrange]> = [
    ["initial manual location", (m) => m.food.locationNote, {}, () => () => {}],
    ["pre-permission", (m) => m.food.prePermissionBody, {}, (m) => () => fireEvent.click(screen.getByRole("button", { name: m.food.useCurrentLocation }))],
    ["locating", (m) => m.food.locating, { acquireCurrentLocation: () => new Promise(() => {}) }, (m) => () => useGps(m)],
    ["map results", (m) => m.food.syntheticMapAttribution, {}, (m) => () => useGps(m)],
    ["list results", (m) => m.food.syntheticDirectorySource, {}, (m) => () => search("123456", m)],
    ["location denied", (m) => m.food.permissionDeniedTitle, {}, (m) => () => {
      fireEvent.click(screen.getByRole("button", { name: m.food.useCurrentLocation }));
      fireEvent.click(screen.getByRole("button", { name: m.food.usePostalInstead }));
    }],
    ["ambiguous location", (m) => m.food.ambiguousTitle, {}, (m) => () => search("Bu", m)],
    ["no results", (m) => m.food.noResultsTitle, { findNearby: async () => ({ kind: "RESULTS", places: [], directory: { kind: "SYNTHETIC" } }) as NearbyFoodResult }, (m) => () => search("123456", m)],
    ["map unavailable", (m) => m.food.mapTilesUnavailable, { profile: hybridProfile, findNearby: async () => HPB_RESULTS }, (m) => async () => {
      await useGps(m);
      fireEvent.click(await screen.findByRole("button", { name: "simulate-tile-failure" }));
    }],
    ["directory unavailable", (m) => m.food.directoryUnavailableTitle, { findNearby: async () => ({ kind: "UNAVAILABLE", reason: "SNAPSHOT_INVALID" }) as NearbyFoodResult }, (m) => () => search("123456", m)],
    ["offline dated snapshot", (m) => m.food.offlineTitle, { profile: hybridProfile, findNearby: async () => HPB_RESULTS, isOnline: () => false }, (m) => () => search("238859", m)],
    ["venue details", (m) => m.food.detailsTitle, {}, (m) => async () => {
      search("123456", m);
      fireEvent.click((await screen.findAllByRole("button", { name: new RegExp(m.food.viewDetails) }))[0]!);
    }],
    ["live search unavailable", (m) => m.food.liveGeocoderUnavailable, { resolveManualLocation: async () => ({ kind: "UNAVAILABLE", reason: "OFFLINE" }) as LocationResolution }, (m) => () => search("Toa Payoh", m)],
  ];

  it.each(STATES)("renders the %s state in both locales with general information reachable", async (_name, text, overrides, arrange) => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const messages = getMessages(locale);
      show(port(overrides), locale);
      await arrange(messages)();
      expect((await screen.findAllByText(text(messages))).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: messages.food.generalInfoAction })).toBeInTheDocument();
      expect(screen.getByText(messages.food.reviewedInfoUnavailable)).toBeInTheDocument();
      cleanup();
    }
  });
});
