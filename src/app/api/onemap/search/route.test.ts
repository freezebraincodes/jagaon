// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneMapSearchHandler } from "./onemap-search-handler";
import { GET } from "./route";

const TOKEN = "test-token-not-real";
const request = (query: string | null) =>
  new Request(`http://localhost/api/onemap/search${query === null ? "" : `?q=${encodeURIComponent(query)}`}`);

const okResponse = (results: unknown[]) =>
  new Response(JSON.stringify({ found: results.length, totalNumPages: 1, pageNum: 1, results }), { status: 200 });

const result = (address: string, lat: string, lon: string) => ({
  SEARCHVAL: address,
  ADDRESS: address,
  POSTAL: "200640",
  LATITUDE: lat,
  LONGITUDE: lon,
  X: "1",
  Y: "2",
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OneMap search route", () => {
  it("reports NOT_CONFIGURED without calling OneMap when the token is absent", async () => {
    const fetcher = vi.fn();
    const handler = createOneMapSearchHandler({ token: undefined, fetcher });
    const response = await handler(request("200640"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the server-only environment token and never returns it", async () => {
    vi.stubEnv("ONEMAP_ACCESS_TOKEN", "");
    const response = await GET(request("200640"));
    expect(await response.json()).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
  });

  it("sends only the query and required flags, with the token as a header", async () => {
    const fetcher = vi.fn(async () => okResponse([result("640 ROWELL ROAD SINGAPORE 200640", "1.30743547948389", "103.854713903431")]));
    const handler = createOneMapSearchHandler({ token: TOKEN, fetcher });
    const response = await handler(request("  200640 "));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      kind: "RESOLVED",
      location: { label: "640 ROWELL ROAD SINGAPORE 200640", coordinates: { latitude: 1.307435, longitude: 103.854714 } },
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.onemap.gov.sg/api/common/elastic/search");
    expect([...parsed.searchParams.keys()].sort()).toEqual(["getAddrDetails", "pageNum", "returnGeom", "searchVal"]);
    expect(parsed.searchParams.get("searchVal")).toBe("200640");
    expect(init.headers).toEqual({ Authorization: TOKEN });
  });

  it("returns AMBIGUOUS for several distinct places and NOT_FOUND for none", async () => {
    const two = vi.fn(async () =>
      okResponse([result("1 A ROAD SINGAPORE 111111", "1.3", "103.8"), result("1 A ROAD SINGAPORE 222222", "1.35", "103.85")]),
    );
    const ambiguous = await (await createOneMapSearchHandler({ token: TOKEN, fetcher: two })(request("a road"))).json();
    expect(ambiguous.kind).toBe("AMBIGUOUS");
    expect(ambiguous.candidates).toHaveLength(2);
    const none = vi.fn(async () => okResponse([]));
    expect(await (await createOneMapSearchHandler({ token: TOKEN, fetcher: none })(request("nowhere"))).json()).toEqual({ kind: "NOT_FOUND" });
  });

  it("maps upstream rejection, rate limits, error payloads, malformed coordinates and timeouts to honest states", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => new Response("{}", { status: 403 }), "REJECTED"],
      [async () => new Response("{}", { status: 401 }), "REJECTED"],
      [async () => new Response("{}", { status: 429 }), "RATE_LIMITED"],
      [async () => new Response("{}", { status: 400 }), "UPSTREAM_ERROR"],
      [async () => new Response(JSON.stringify({ error: "Invalid token" }), { status: 200 }), "REJECTED"],
      [async () => okResponse([result("X", "not-a-number", "103.8")]), "UPSTREAM_ERROR"],
      [async () => okResponse([result("London", "51.5", "-0.12")]), "UPSTREAM_ERROR"],
      [async () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "TIMEOUT"],
      [async () => Promise.reject(new TypeError("fetch failed")), "UPSTREAM_ERROR"],
    ];
    for (const [fetcher, reason] of cases) {
      const response = await createOneMapSearchHandler({ token: TOKEN, fetcher })(request("200640"));
      expect(response.status, reason).toBe(502);
      expect(await response.json()).toEqual({ kind: "UNAVAILABLE", reason });
    }
  });

  it("rejects an empty, over-long or control-character query before any upstream call", async () => {
    const fetcher = vi.fn();
    const handler = createOneMapSearchHandler({ token: TOKEN, fetcher });
    for (const query of [null, "   ", "x".repeat(81), "abc\u0000def"]) {
      const response = await handler(request(query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ kind: "INVALID_QUERY" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("logs nothing about the query, coordinates or token", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const fetcher = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    await createOneMapSearchHandler({ token: TOKEN, fetcher })(request("200640"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
