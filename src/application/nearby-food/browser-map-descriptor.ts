import type { MapProviderDescriptor } from "./nearby-food-contracts";

/**
 * OneMap XYZ basemap (no token required). Values and the mandatory
 * attribution follow https://www.onemap.gov.sg/docs/maps/ (checked 2026-10-04).
 */
export const ONEMAP_TILE_DESCRIPTOR = Object.freeze({
  kind: "ONEMAP_TILES",
  tileUrlTemplate: "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png",
  minZoom: 11,
  maxZoom: 19,
  privacyUrl: "https://www.onemap.gov.sg/legal/privacystatement.html",
  termsUrl: "https://www.onemap.gov.sg/legal/termsofuse.html",
}) satisfies Extract<MapProviderDescriptor, { kind: "ONEMAP_TILES" }>;

/** OneMap's required attribution markup ("DO NOT REMOVE"), passed to Leaflet verbatim. */
export const ONEMAP_REQUIRED_ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px;" alt="OneMap"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';
