import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { ONEMAP_TILE_DESCRIPTOR } from "@/application/nearby-food/browser-map-descriptor";

type Handler = (...args: unknown[]) => void;
const created = vi.hoisted(() => ({
  maps: [] as Array<{ removed: boolean; options: Record<string, unknown> }>,
  tileLayers: [] as Array<{ url: string; options: Record<string, unknown>; handlers: Record<string, Handler> }>,
  markers: [] as Array<{ latlng: [number, number]; options: Record<string, unknown>; handlers: Record<string, Handler> }>,
}));

vi.mock("leaflet", () => {
  const map = (_el: HTMLElement, options: Record<string, unknown>) => {
    const entry = { removed: false, options };
    created.maps.push(entry);
    const api = {
      setView: () => api,
      fitBounds: () => api,
      remove: () => {
        entry.removed = true;
      },
    };
    return api;
  };
  const tileLayer = (url: string, options: Record<string, unknown>) => {
    const entry = { url, options, handlers: {} as Record<string, Handler> };
    created.tileLayers.push(entry);
    const api = {
      on: (name: string, handler: Handler) => {
        entry.handlers[name] = handler;
        return api;
      },
      addTo: () => api,
    };
    return api;
  };
  const marker = (latlng: [number, number], options: Record<string, unknown>) => {
    const entry = { latlng, options, handlers: {} as Record<string, Handler> };
    created.markers.push(entry);
    const api = {
      on: (name: string, handler: Handler) => {
        entry.handlers[name] = handler;
        return api;
      },
      addTo: () => api,
    };
    return api;
  };
  const leaflet = { map, tileLayer, marker, divIcon: (options: unknown) => options, latLngBounds: (points: unknown) => points };
  return { default: leaflet, ...leaflet };
});

import { OneMapView } from "./OneMapView";

const en = getMessages("en-SG");
const places = [
  { id: "hpb-1", name: "Cafe One", number: 1, coordinates: { latitude: 1.301, longitude: 103.85 } },
  { id: "hpb-2", name: "Cafe Two", number: 2, coordinates: { latitude: 1.302, longitude: 103.85 } },
];

beforeEach(() => {
  created.maps.length = 0;
  created.tileLayers.length = 0;
  created.markers.length = 0;
});
afterEach(() => cleanup());

describe("OneMapView", () => {
  it("renders client-side OneMap tiles with the mandatory OneMap/SLA attribution and bilingual links", async () => {
    const view = render(
      <OneMapView messages={en} descriptor={ONEMAP_TILE_DESCRIPTOR} origin={{ latitude: 1.3, longitude: 103.85 }} places={places} onSelect={() => {}} onUnavailable={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(en.food.liveMapLoading);
    await waitFor(() => expect(created.tileLayers).toHaveLength(1));
    const tiles = created.tileLayers[0]!;
    expect(tiles.url).toBe("https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png");
    expect(tiles.options).toMatchObject({ minZoom: 11, maxZoom: 19, detectRetina: true });
    expect(String(tiles.options.attribution)).toContain("om_logo.png");
    expect(String(tiles.options.attribution)).toContain("Singapore Land Authority");
    expect(screen.getByText(en.food.oneMapAttribution)).toBeInTheDocument();
    const privacy = screen.getByRole("link", { name: en.food.oneMapPrivacy });
    expect(privacy).toHaveAttribute("href", "https://www.onemap.gov.sg/legal/privacystatement.html");
    expect(screen.getByRole("region", { name: en.food.viewMap })).toBeInTheDocument();
    view.unmount();
    expect(created.maps[0]!.removed).toBe(true);
  });

  it("adds keyboard-focusable numbered markers that select a place", async () => {
    const onSelect = vi.fn();
    render(<OneMapView messages={en} descriptor={ONEMAP_TILE_DESCRIPTOR} origin={{ latitude: 1.3, longitude: 103.85 }} places={places} onSelect={onSelect} onUnavailable={() => {}} />);
    await waitFor(() => expect(created.markers).toHaveLength(2));
    expect(created.markers[0]!.options).toMatchObject({ keyboard: true, title: "1 Cafe One", alt: "1 Cafe One" });
    act(() => created.markers[1]!.handlers.click!());
    expect(onSelect).toHaveBeenCalledWith("hpb-2");
  });

  it("reports the map unavailable after repeated tile errors before any tile loads", async () => {
    const onUnavailable = vi.fn();
    render(<OneMapView messages={en} descriptor={ONEMAP_TILE_DESCRIPTOR} origin={{ latitude: 1.3, longitude: 103.85 }} places={places} onSelect={() => {}} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(created.tileLayers).toHaveLength(1));
    const handlers = created.tileLayers[0]!.handlers;
    act(() => {
      handlers.tileerror!();
      handlers.tileerror!();
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    act(() => handlers.tileerror!());
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps working once a tile has loaded even if later tiles fail", async () => {
    const onUnavailable = vi.fn();
    render(<OneMapView messages={en} descriptor={ONEMAP_TILE_DESCRIPTOR} origin={{ latitude: 1.3, longitude: 103.85 }} places={places} onSelect={() => {}} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(created.tileLayers).toHaveLength(1));
    const handlers = created.tileLayers[0]!.handlers;
    act(() => {
      handlers.tileload!();
      handlers.tileerror!();
      handlers.tileerror!();
      handlers.tileerror!();
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
