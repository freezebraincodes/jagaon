import { z } from "zod";
import { coordinatesSchema, isWithinSingapore, type LocationResolution, type ResolvedLocation } from "@/application/nearby-food/nearby-food-contracts";

/**
 * Server-side OneMap address search (Packet 9A Task 3).
 *
 * - The access token is read on the server only and never returned.
 * - Only the trimmed query and OneMap's required flags leave the server.
 * - No request, query, coordinate or token is logged.
 * - Every failure becomes an explicit UNAVAILABLE reason so the screen can
 *   fall back to postal/snapshot search without claiming live results.
 */

export const ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const MAX_QUERY_LENGTH = 80;
const MAX_CANDIDATES = 5;
const UPSTREAM_TIMEOUT_MS = 5000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const oneMapPayloadSchema = z.object({
  results: z.array(
    z.object({
      ADDRESS: z.string().min(1).max(300),
      LATITUDE: z.string(),
      LONGITUDE: z.string(),
    }),
  ),
});

type RouteBody = LocationResolution | { kind: "INVALID_QUERY" };

function reply(body: RouteBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const unavailable = (reason: Extract<LocationResolution, { kind: "UNAVAILABLE" }>["reason"], status = 502) => reply({ kind: "UNAVAILABLE", reason }, status);

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export function createOneMapSearchHandler(options: { token: string | undefined; fetcher?: Fetcher }) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));

  return async function handle(request: Request): Promise<Response> {
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (query.length === 0 || query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
      return reply({ kind: "INVALID_QUERY" }, 400);
    }
    const token = options.token?.trim();
    // Not configured is a deployment profile, not a fault: answer 200 with an
    // explicit body so the expected fallback path raises no browser error.
    if (!token) return unavailable("NOT_CONFIGURED", 200);

    const url = new URL(ONEMAP_SEARCH_URL);
    url.searchParams.set("searchVal", query);
    url.searchParams.set("returnGeom", "Y");
    url.searchParams.set("getAddrDetails", "Y");
    url.searchParams.set("pageNum", "1");

    let upstream: Response;
    try {
      upstream = await fetcher(url.toString(), {
        method: "GET",
        headers: { Authorization: token },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
        cache: "no-store",
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return unavailable(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR");
    }
    if (upstream.status === 401 || upstream.status === 403) return unavailable("REJECTED");
    if (upstream.status === 429) return unavailable("RATE_LIMITED");
    if (!upstream.ok) return unavailable("UPSTREAM_ERROR");

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return unavailable("UPSTREAM_ERROR");
    }
    if (payload && typeof payload === "object" && "error" in payload) return unavailable("REJECTED");
    const parsed = oneMapPayloadSchema.safeParse(payload);
    if (!parsed.success) return unavailable("UPSTREAM_ERROR");

    const candidates: ResolvedLocation[] = [];
    for (const entry of parsed.data.results.slice(0, MAX_CANDIDATES)) {
      const coordinates = coordinatesSchema.safeParse({ latitude: round6(Number(entry.LATITUDE)), longitude: round6(Number(entry.LONGITUDE)) });
      // A malformed or out-of-Singapore coordinate means the answer cannot be trusted.
      if (!coordinates.success || !isWithinSingapore(coordinates.data)) return unavailable("UPSTREAM_ERROR");
      const duplicate = candidates.some(
        (candidate) => candidate.coordinates.latitude === coordinates.data.latitude && candidate.coordinates.longitude === coordinates.data.longitude,
      );
      if (!duplicate) candidates.push({ label: entry.ADDRESS.trim(), coordinates: coordinates.data });
    }
    if (candidates.length === 0) return reply({ kind: "NOT_FOUND" }, 200);
    if (candidates.length === 1) return reply({ kind: "RESOLVED", location: candidates[0]! }, 200);
    return reply({ kind: "AMBIGUOUS", candidates }, 200);
  };
}
