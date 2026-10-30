import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EtaError,
  estimateRoute,
  geocode,
  MAX_PATH_POINTS,
  resetEtaState,
  toPath,
} from "../../src/services/eta.service.js";

/** "How long until it gets there": the place is found in OpenStreetMap, the road time comes from OSRM, and the shared servers are spared. */

const MILAN = { lat: 45.4642, lng: 9.19 };
const noWait = async () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const place = (extra: object = {}) => ({
  lat: "41.9",
  lon: "12.5",
  name: "Roma",
  display_name: "Roma, Roma Capitale, Lacio, Italia",
  address: { city: "Roma", county: "Roma Capitale", state: "Lacio" },
  ...extra,
});
const road = (meters: number, seconds: number) =>
  json({ code: "Ok", routes: [{ distance: meters, duration: seconds }] });

describe("how long a vehicle takes to reach a place", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetEtaState();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("looks the place up near the vehicle, naming itself, and says what it found", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        place({
          name: "Via Roma 1",
          address: { road: "Via Roma", house_number: "1", town: "Torre Pellice", county: "Turín" },
        }),
      ]),
    );
    const found = await geocode("  Via Roma 1   Torino ", MILAN, noWait);
    expect(found).toEqual({ lat: 41.9, lng: 12.5, label: "Via Roma 1, Torre Pellice, Turín" });

    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.hostname).toBe("nominatim.openstreetmap.org");
    expect(u.searchParams.get("q")).toBe("Via Roma 1 Torino");
    expect(u.searchParams.get("viewbox")).toBe("7.1900,47.4642,11.1900,43.4642");
    expect((init as RequestInit).headers).toMatchObject({
      "User-Agent": expect.stringContaining("OneSystec"),
    });
  });

  it("asks once for the same place and leaves a second of room between different ones", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    fetchMock.mockImplementation(async () => json([place()]));
    await geocode("Roma", MILAN, sleep);
    await geocode("roma ", MILAN, sleep);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await geocode("Napoli", MILAN, sleep);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(900);
  });

  it("adds the traffic allowance to the road time and rounds the distance", async () => {
    fetchMock.mockResolvedValueOnce(json([place()])).mockResolvedValueOnce(road(52_849, 3_600));
    const estimate = await estimateRoute(MILAN, "Roma", noWait);
    expect(estimate).toMatchObject({
      distanceKm: 52.8,
      baseDurationMin: 60,
      durationMin: 69,
      destination: { label: "Roma, Roma Capitale" },
    });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/route/v1/driving/9.19,45.4642;12.5,41.9");
  });

  it("returns the road ahead as [lat, lng] points, thinned out but keeping both ends", async () => {
    const line = Array.from({ length: 2_500 }, (_, i) => [9.19 + i * 0.001, 45.46 - i * 0.0005]);
    fetchMock
      .mockResolvedValueOnce(json([place()]))
      .mockResolvedValueOnce(
        json({ code: "Ok", routes: [{ distance: 1000, duration: 60, geometry: { coordinates: line } }] }),
      );
    const { path } = await estimateRoute(MILAN, "Roma", noWait);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("overview=full&geometries=geojson");
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_POINTS + 1);
    expect(path[0]).toEqual([45.46, 9.19]);
    expect(path[path.length - 1]).toEqual([
      Math.round((45.46 - 2_499 * 0.0005) * 1e5) / 1e5,
      Math.round((9.19 + 2_499 * 0.001) * 1e5) / 1e5,
    ]);
  });

  it("copes with a route that comes without a line, or with junk in it", () => {
    expect(toPath(undefined)).toEqual([]);
    expect(toPath([[9.1, 45.1], "x", [Number.NaN, 1], [9.2, 45.2]])).toEqual([
      [45.1, 9.1],
      [45.2, 9.2],
    ]);
  });

  it("says so when nothing matches, and when there is no road between the two", async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    await expect(estimateRoute(MILAN, "zzzz qqqq", noWait)).rejects.toMatchObject({ status: 404 });

    fetchMock
      .mockResolvedValueOnce(json([place()]))
      .mockResolvedValueOnce(json({ code: "NoRoute", routes: [] }));
    await expect(estimateRoute(MILAN, "Roma", noWait)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a text too short or too long before asking anyone", async () => {
    await expect(geocode("ab", MILAN, noWait)).rejects.toBeInstanceOf(EtaError);
    await expect(geocode("x".repeat(121), MILAN, noWait)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a map service that is down as a bad gateway, not as a missing place", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(geocode("Roma", MILAN, noWait)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    await expect(geocode("Milano", MILAN, noWait)).rejects.toMatchObject({ status: 502 });
  });
});
