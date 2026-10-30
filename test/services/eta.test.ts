import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtaError, estimateRoute, geocode, resetEtaState } from "../../src/services/eta.service.js";

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
