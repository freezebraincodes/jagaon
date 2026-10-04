#!/usr/bin/env node
/**
 * Packet 9A: deterministic HPB Healthier Dining snapshot transform.
 *
 * Inputs (explicit local paths; this script performs no network access):
 *   --fnb   CSV of data.gov.sg dataset d_c475b9170c08f90580f4041bffd51639
 *   --geo   GeoJSON of data.gov.sg dataset d_2925c2ccf75d1c135c2d469e0de3cee6
 *   --meta  JSON { criteria: {lastUpdatedAt, retrievedAt}, coordinates: {...} }
 *   --out   output directory (writes hpb-nearby-food-v1.json and its manifest)
 *
 * Approved matching rules (owner decision 2026-10-04):
 *   R1  exactly one "Singapore NNNNNN" postal code in Outlet_Address, else rejected;
 *   R2  at most one "#FF-UU" unit, normalised (leading zeros removed);
 *   R3  accept when exactly one geo point has the same postal + floor + unit and
 *       that key is unique among F&B rows;
 *   R3B without a unit, accept when the postal code has exactly one geo point
 *       and exactly one F&B row;
 *   R4  otherwise unmatched or ambiguous: no governed criteria, counted.
 * Geo points without an accepted F&B row remain plain, unbadged venues.
 * Criteria strings are preserved verbatim (only list separators are split
 * and surrounding whitespace trimmed); an unknown string fails the run.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TRANSFORM_VERSION = "transform-hpb-nearby-food.1";
export const SNAPSHOT_VERSION = "hpb-nearby-food.1";

/** Exact HPB "Menu Item Endorsement Criteria" vocabulary, in display order. */
export const HPB_CRITERIA_V1 = Object.freeze([
  "Higher in wholegrains",
  "Higher in wholegrains and lower in calories",
  "Lower in sugar",
  "Lower in sugar and source of dietary fibre",
  "Lower in calories",
  "Lower in calories and sodium",
  "No added sugar",
  "Healthier children's meal",
  "Lower in sodium",
]);

const SINGAPORE = { south: 1.13, north: 1.48, west: 103.59, east: 104.1 };
const CUISINE_GROUP_BY_CATEGORY = Object.freeze({ Chinese: "CHINESE", Indian: "INDIAN", Western: "WESTERN", Malay: "MALAY" });

/** RFC 4180 CSV: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const normaliseUnitPart = (value) => {
  const text = String(value ?? "").trim().toUpperCase();
  if (text === "") return null;
  if (/^B\d+$/.test(text)) return `B${Number(text.slice(1))}`;
  return /^\d+$/.test(text) ? String(Number(text)) : text;
};

const postalOf = (address) => {
  const found = [...address.matchAll(/Singapore\s*(\d{6})/gi)].map((match) => match[1]);
  return found.length === 1 ? found[0] : null;
};

const unitOf = (address) => {
  const found = [...address.matchAll(/#\s*(B?\d+)\s*-\s*(\d+)/gi)];
  if (found.length === 0) return { kind: "NONE" };
  if (found.length > 1) return { kind: "MULTIPLE" };
  return { kind: "ONE", floor: normaliseUnitPart(found[0][1]), unit: normaliseUnitPart(found[0][2]) };
};

const criteriaOf = (text) => {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const item of items) {
    if (!HPB_CRITERIA_V1.includes(item)) throw new Error(`UNKNOWN_CRITERION: ${JSON.stringify(item)}`);
  }
  return HPB_CRITERIA_V1.filter((criterion) => items.includes(criterion));
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const localDateOf = (instant) => String(instant).slice(0, 10);

/**
 * Pure transform: identical inputs always produce byte-identical output.
 * @param {{ fnbCsvText: string, geoJsonText: string, metadata: { criteria: { lastUpdatedAt: string }, coordinates: { lastUpdatedAt: string } } }} input
 */
export function transformHpbSources(input) {
  const [header, ...records] = parseCsv(input.fnbCsvText);
  const column = (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`MISSING_COLUMN: ${name}`);
    return index;
  };
  const col = {
    setting: column("FnB_Setting"),
    category: column("Category"),
    outlet: column("Name_of_Outlet"),
    address: column("Outlet_Address"),
    criteria: column("Menu_Item_Endorsement_Criteria"),
  };

  const counts = {
    criteriaInputRows: records.length,
    criteriaAccepted: 0,
    criteriaRejected: 0,
    criteriaUnmatched: 0,
    criteriaAmbiguous: 0,
    coordinateInputFeatures: 0,
    coordinateAccepted: 0,
    coordinateRejected: 0,
    venuesWithGovernedCriteria: 0,
    venuesWithoutGovernedCriteria: 0,
  };
  const review = { accepted: [], unmatched: [], ambiguous: [], rejected: [] };

  // --- Geospatial points ------------------------------------------------------------------
  const geo = JSON.parse(input.geoJsonText);
  const points = [];
  for (const feature of geo.features ?? []) {
    counts.coordinateInputFeatures += 1;
    const p = feature?.properties ?? {};
    const coordinates = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
    const longitude = Array.isArray(coordinates) ? Number(coordinates[0]) : Number.NaN;
    const latitude = Array.isArray(coordinates) ? Number(coordinates[1]) : Number.NaN;
    const postal = p.ADDRESSPOSTALCODE == null ? null : String(p.ADDRESSPOSTALCODE).trim().padStart(6, "0");
    const valid =
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= SINGAPORE.south &&
      latitude <= SINGAPORE.north &&
      longitude >= SINGAPORE.west &&
      longitude <= SINGAPORE.east &&
      Number.isInteger(p.OBJECTID) &&
      typeof p.NAME === "string" &&
      p.NAME.trim().length > 0 &&
      postal !== null &&
      /^\d{6}$/.test(postal);
    if (!valid) {
      counts.coordinateRejected += 1;
      continue;
    }
    counts.coordinateAccepted += 1;
    const floor = normaliseUnitPart(p.ADDRESSFLOORNUMBER);
    const unit = normaliseUnitPart(p.ADDRESSUNITNUMBER);
    const unitText = floor && unit ? `#${String(p.ADDRESSFLOORNUMBER).trim()}-${String(p.ADDRESSUNITNUMBER).trim()}` : null;
    const address = [p.ADDRESSBLOCKHOUSENUMBER, p.ADDRESSSTREETNAME, p.ADDRESSBUILDINGNAME, unitText, `Singapore ${postal}`]
      .map((part) => (part == null ? "" : String(part).trim()))
      .filter((part) => part.length > 0)
      .join(" ");
    points.push({ objectId: p.OBJECTID, name: p.NAME.trim(), address, latitude: round6(latitude), longitude: round6(longitude), postal, floor, unit });
  }
  const pointsByPostal = new Map();
  for (const point of points) pointsByPostal.set(point.postal, [...(pointsByPostal.get(point.postal) ?? []), point]);

  // --- Criteria rows ----------------------------------------------------------------------
  const parsedRows = records.map((record, index) => {
    const address = (record[col.address] ?? "").trim();
    return {
      index,
      outlet: (record[col.outlet] ?? "").trim(),
      address,
      setting: (record[col.setting] ?? "").trim(),
      category: (record[col.category] ?? "").trim(),
      criteria: criteriaOf(record[col.criteria] ?? ""),
      postal: postalOf(address),
      unit: unitOf(address),
    };
  });
  const keyOf = (row) => (row.unit.kind === "ONE" ? `${row.postal}|${row.unit.floor}|${row.unit.unit}` : `${row.postal}|NONE`);
  const rowsPerKey = new Map();
  const rowsPerPostal = new Map();
  for (const row of parsedRows) {
    if (row.postal === null || row.unit.kind === "MULTIPLE") continue;
    rowsPerKey.set(keyOf(row), (rowsPerKey.get(keyOf(row)) ?? 0) + 1);
    rowsPerPostal.set(row.postal, (rowsPerPostal.get(row.postal) ?? 0) + 1);
  }

  const claims = new Map();
  for (const row of parsedRows) {
    const summary = { outlet: row.outlet, address: row.address };
    if (row.postal === null || row.unit.kind === "MULTIPLE") {
      counts.criteriaRejected += 1;
      review.rejected.push({ ...summary, reason: row.postal === null ? "R1_NO_SINGLE_POSTAL" : "R2_MULTIPLE_UNITS" });
      continue;
    }
    const candidates = pointsByPostal.get(row.postal) ?? [];
    if (candidates.length === 0) {
      counts.criteriaUnmatched += 1;
      review.unmatched.push({ ...summary, reason: "POSTAL_ABSENT_FROM_COORDINATES" });
      continue;
    }
    let match = null;
    let reason = null;
    if (row.unit.kind === "ONE") {
      const exact = candidates.filter((point) => point.floor === row.unit.floor && point.unit === row.unit.unit);
      if (exact.length === 0) reason = "UNMATCHED_UNIT";
      else if (exact.length > 1) reason = "AMBIGUOUS_COORDINATE_POINTS";
      else if (rowsPerKey.get(keyOf(row)) !== 1) reason = "AMBIGUOUS_DUPLICATE_CRITERIA_ROWS";
      else match = exact[0];
    } else if (candidates.length === 1 && rowsPerPostal.get(row.postal) === 1) {
      match = candidates[0];
    } else {
      reason = "AMBIGUOUS_NO_UNIT";
    }
    if (match === null) {
      if (reason === "UNMATCHED_UNIT") {
        counts.criteriaUnmatched += 1;
        review.unmatched.push({ ...summary, reason });
      } else {
        counts.criteriaAmbiguous += 1;
        review.ambiguous.push({ ...summary, reason });
      }
      continue;
    }
    claims.set(match.objectId, [...(claims.get(match.objectId) ?? []), row]);
  }

  // A coordinate point claimed by more than one criteria row stays unbadged.
  const acceptedByPoint = new Map();
  for (const [objectId, rows] of claims) {
    if (rows.length === 1) {
      acceptedByPoint.set(objectId, rows[0]);
      counts.criteriaAccepted += 1;
    } else {
      counts.criteriaAmbiguous += rows.length;
      for (const row of rows) review.ambiguous.push({ outlet: row.outlet, address: row.address, reason: "AMBIGUOUS_SHARED_POINT" });
    }
  }

  const venues = points
    .sort((a, b) => a.objectId - b.objectId)
    .map((point) => {
      const row = acceptedByPoint.get(point.objectId);
      if (row) review.accepted.push({ outlet: row.outlet, address: row.address, venue: point.name, venueAddress: point.address });
      const group = row ? CUISINE_GROUP_BY_CATEGORY[row.category] : undefined;
      return {
        id: `hpb-${point.objectId}`,
        name: point.name,
        address: point.address,
        latitude: point.latitude,
        longitude: point.longitude,
        cuisineLabels: row && row.category ? [row.category] : [],
        cuisineGroups: group ? [group] : [],
        venueType: row && row.setting === "Hawker" ? "HAWKER_CENTRE" : null,
        criteria: row ? row.criteria : [],
      };
    });
  counts.venuesWithGovernedCriteria = venues.filter((venue) => venue.criteria.length > 0).length;
  counts.venuesWithoutGovernedCriteria = venues.length - counts.venuesWithGovernedCriteria;

  const snapshot = {
    schemaVersion: 1,
    snapshotVersion: SNAPSHOT_VERSION,
    criteriaDatasetDate: localDateOf(input.metadata.criteria.lastUpdatedAt),
    coordinatesDatasetDate: localDateOf(input.metadata.coordinates.lastUpdatedAt),
    venues,
  };
  return { snapshot, snapshotText: `${JSON.stringify(snapshot)}\n`, counts, review };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1]) throw new Error(`Missing --${name}`);
    return argv[index + 1];
  };
  const fnbBytes = readFileSync(arg("fnb"));
  const geoBytes = readFileSync(arg("geo"));
  const meta = JSON.parse(readFileSync(arg("meta"), "utf8"));
  const out = arg("out");
  const result = transformHpbSources({ fnbCsvText: fnbBytes.toString("utf8"), geoJsonText: geoBytes.toString("utf8"), metadata: meta });
  const snapshotBytes = Buffer.from(result.snapshotText, "utf8");
  const manifest = {
    schemaVersion: 1,
    snapshotVersion: SNAPSHOT_VERSION,
    transformVersion: TRANSFORM_VERSION,
    sources: [
      {
        role: "CRITERIA",
        datasetId: "d_c475b9170c08f90580f4041bffd51639",
        name: "Healthier Dining Partners - F&B Partners",
        publisher: "Health Promotion Board",
        sourceUrl: "https://data.gov.sg/datasets/d_c475b9170c08f90580f4041bffd51639/view",
        format: "CSV",
        sourcePublishedAt: meta.criteria.lastUpdatedAt,
        retrievedAt: meta.criteria.retrievedAt,
        sha256: sha256(fnbBytes),
        byteLength: fnbBytes.length,
      },
      {
        role: "COORDINATES",
        datasetId: "d_2925c2ccf75d1c135c2d469e0de3cee6",
        name: "Healthier Eateries",
        publisher: "Health Promotion Board",
        sourceUrl: "https://data.gov.sg/datasets/d_2925c2ccf75d1c135c2d469e0de3cee6/view",
        format: "GEOJSON",
        sourcePublishedAt: meta.coordinates.lastUpdatedAt,
        retrievedAt: meta.coordinates.retrievedAt,
        sha256: sha256(geoBytes),
        byteLength: geoBytes.length,
      },
    ],
    licence: { name: "Singapore Open Data Licence version 1.0", url: "https://data.gov.sg/open-data-licence" },
    snapshot: { path: "data/hpb-nearby-food-v1.json", sha256: sha256(snapshotBytes), byteLength: snapshotBytes.length },
    counts: result.counts,
    matchingRules: ["R1_SINGLE_POSTAL", "R2_SINGLE_UNIT", "R3_UNIQUE_POSTAL_FLOOR_UNIT", "R3B_SINGLE_POSTAL_NO_UNIT", "R4_OTHERWISE_UNBADGED"],
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "hpb-nearby-food-v1.json"), snapshotBytes);
  writeFileSync(join(out, "hpb-nearby-food-v1.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (argv.includes("--review")) writeFileSync(arg("review"), `${JSON.stringify(result.review, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ counts: result.counts, snapshotSha256: manifest.snapshot.sha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
