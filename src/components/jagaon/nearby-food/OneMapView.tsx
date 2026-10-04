"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import type { Coordinates, MapProviderDescriptor } from "@/application/nearby-food/nearby-food-contracts";
import { ONEMAP_REQUIRED_ATTRIBUTION } from "@/application/nearby-food/browser-map-descriptor";

export type MapPlace = { id: string; name: string; number: number; coordinates: Coordinates };

type Props = {
  messages: AppMessages;
  descriptor: Extract<MapProviderDescriptor, { kind: "ONEMAP_TILES" }>;
  origin: Coordinates;
  places: readonly MapPlace[];
  onSelect: (placeId: string) => void;
  /** Called once when tiles cannot be shown; the caller keeps the list. */
  onUnavailable: () => void;
};

/** Failed tiles tolerated before any tile has loaded. */
const TILE_FAILURE_LIMIT = 3;

/**
 * OneMap basemap rendered client-side with Leaflet (Packet 9A Task 3).
 * Leaflet loads only in the browser, the OneMap attribution is mandatory,
 * markers are keyboard-focusable, and repeated tile failure hands control
 * back to the list rather than showing a blank or invented map.
 */
export function OneMapView({ messages, descriptor, origin, places, onSelect, onUnavailable }: Props) {
  const msg = messages.food;
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const selectRef = useRef(onSelect);
  const unavailableRef = useRef(onUnavailable);

  useEffect(() => {
    selectRef.current = onSelect;
    unavailableRef.current = onUnavailable;
  }, [onSelect, onUnavailable]);

  const placesKey = JSON.stringify(places.map((place) => [place.id, place.number, place.coordinates.latitude, place.coordinates.longitude]));

  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | null = null;
    let reported = false;
    const reportUnavailable = () => {
      if (reported || disposed) return;
      reported = true;
      unavailableRef.current();
    };

    void import("leaflet")
      .then((module) => {
        const L = module.default;
        const container = containerRef.current;
        if (disposed || !container) return;
        const map = L.map(container, { zoomControl: true, attributionControl: true, minZoom: descriptor.minZoom, maxZoom: descriptor.maxZoom });
        remove = () => map.remove();
        map.setView([origin.latitude, origin.longitude], 16);

        let loadedAny = false;
        let failures = 0;
        L.tileLayer(descriptor.tileUrlTemplate, {
          detectRetina: true,
          minZoom: descriptor.minZoom,
          maxZoom: descriptor.maxZoom,
          attribution: ONEMAP_REQUIRED_ATTRIBUTION,
        })
          .on("tileload", () => {
            loadedAny = true;
            if (!disposed) setReady(true);
          })
          .on("tileerror", () => {
            if (loadedAny) return;
            failures += 1;
            if (failures >= TILE_FAILURE_LIMIT) reportUnavailable();
          })
          .addTo(map);

        for (const place of places) {
          const label = `${place.number} ${place.name}`;
          L.marker([place.coordinates.latitude, place.coordinates.longitude], {
            keyboard: true,
            title: label,
            alt: label,
            icon: L.divIcon({ className: "onemap-marker", html: `<span aria-hidden="true">${place.number}</span>`, iconSize: [36, 36] }),
          })
            .on("click", () => selectRef.current(place.id))
            .addTo(map);
        }
        if (places.length > 0) {
          map.fitBounds(
            L.latLngBounds([[origin.latitude, origin.longitude], ...places.map((place) => [place.coordinates.latitude, place.coordinates.longitude] as [number, number])]),
            { padding: [24, 24], maxZoom: 17 },
          );
        }
      })
      .catch(() => reportUnavailable());

    return () => {
      disposed = true;
      remove?.();
    };
    // The map is rebuilt only when its inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor, origin.latitude, origin.longitude, placesKey]);

  return (
    <div className="provider-map provider-map--onemap" role="region" aria-label={msg.viewMap}>
      {!ready ? (
        <p className="provider-map-loading" role="status">
          {msg.liveMapLoading}
        </p>
      ) : null}
      <div ref={containerRef} className="onemap-canvas" />
      <p className="provider-map-attribution">
        <span>{msg.oneMapAttribution}</span>
        <span aria-hidden="true"> · </span>
        <a href={descriptor.privacyUrl} target="_blank" rel="noopener noreferrer">
          {msg.oneMapPrivacy}
        </a>
      </p>
    </div>
  );
}
