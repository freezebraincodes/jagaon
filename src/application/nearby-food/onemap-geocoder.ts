import { z } from "zod";
import { coordinatesSchema, isWithinSingapore, type GeocoderPort, type LocationResolution } from "./nearby-food-contracts";

/**
 * Browser-side OneMap geocoder: calls only the same-origin route, which holds
 * the token. The request carries the typed query and nothing else.
 */

const locationSchema = z.strictObject({ label: z.string().min(1).max(300), coordinates: coordinatesSchema });

const resolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("RESOLVED"), location: locationSchema }),
  z.strictObject({ kind: z.literal("AMBIGUOUS"), candidates: z.array(locationSchema).min(2).max(5) }),
  z.strictObject({ kind: z.literal("NOT_FOUND") }),
  z.strictObject({
    kind: z.literal("UNAVAILABLE"),
    reason: z.enum(["NOT_CONFIGURED", "OFFLINE", "REJECTED", "RATE_LIMITED", "UPSTREAM_ERROR", "TIMEOUT"]),
  }),
]);

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

export function createOneMapGeocoder(fetcher: Fetcher, endpoint: string): GeocoderPort {
  return Object.freeze({
    providerId: "ONEMAP" as const,
    async resolve(query: string, signal?: AbortSignal): Promise<LocationResolution> {
      let response: Response;
      try {
        response = await fetcher(`${endpoint}?q=${encodeURIComponent(query.trim())}`, { method: "GET", cache: "no-store", signal });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        return { kind: "UNAVAILABLE", reason: "OFFLINE" };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        return { kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" };
      }
      const parsed = resolutionSchema.safeParse(body);
      if (!parsed.success) return { kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" };
      const result = parsed.data;
      const inArea = (point: { latitude: number; longitude: number }) => isWithinSingapore(point);
      if (result.kind === "RESOLVED" && !inArea(result.location.coordinates)) return { kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" };
      if (result.kind === "AMBIGUOUS" && !result.candidates.every((candidate) => inArea(candidate.coordinates))) {
        return { kind: "UNAVAILABLE", reason: "UPSTREAM_ERROR" };
      }
      return result;
    },
  });
}
