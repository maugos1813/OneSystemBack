import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Gamonal vehicles a client sees on the OneTrack map are the ones Gamonal Driver shows them: nothing is decided here. */

vi.mock("../../src/config/env.js", () => ({
  env: { DRIVER_API_URL: "https://driver.test/api", SSO_SHARED_SECRET: "test-secret-test-secret-test-secret" },
}));

vi.mock("../../src/config/logger.js", () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }));

const { listDriverVehiclesFor, clearDriverVehiclesCache } = await import("../../src/services/driverVehicles.service.js");

const live = (vehiculos: unknown[]) => new Response(JSON.stringify({ data: { vehiculos } }), { status: 200 });
const session = (accessToken = "tok-1") => new Response(JSON.stringify({ data: { accessToken, user: {} } }), { status: 200 });

describe("the vehicles Gamonal Driver shows a client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearDriverVehiclesCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs in as the person, reads their live map and cleans up what comes back", async () => {
    fetchMock.mockResolvedValueOnce(session()).mockResolvedValueOnce(
      live([
        { targa: "ab 123 cd", lat: 45.46, lng: 9.19, speed: 40, ignition: true, direction: 90, updatedAt: "2026-10-24T12:00:00Z" },
        { targa: "EF456GH", lat: 45.5, lng: 9.2, speed: null, ignition: null, direction: null, updatedAt: null },
        { targa: "NOPOS", lat: null, lng: 9.2 },
        { lat: 1, lng: 2 },
        "garbage",
      ]),
    );
    const vehicles = await listDriverVehiclesFor("p@piazza.it", 1_000);
    expect(vehicles).toEqual([
      { plate: "AB123CD", lat: 45.46, lng: 9.19, speed: 40, ignition: true, direction: 90, updatedAt: "2026-10-24T12:00:00Z" },
      { plate: "EF456GH", lat: 45.5, lng: 9.2, speed: null, ignition: null, direction: null, updatedAt: null },
    ]);
    const [ssoUrl, ssoInit] = fetchMock.mock.calls[0]!;
    expect(ssoUrl).toBe("https://driver.test/api/auth/sso");
    expect(JSON.parse(ssoInit.body).ticket).toEqual(expect.any(String));
    const [liveUrl, liveInit] = fetchMock.mock.calls[1]!;
    expect(liveUrl).toBe("https://driver.test/api/cliente/en-vivo");
    expect(liveInit.headers.Authorization).toBe("Bearer tok-1");
  });

  it("answers from memory for a few seconds, and reuses the session afterwards", async () => {
    fetchMock.mockResolvedValueOnce(session()).mockResolvedValueOnce(live([{ targa: "AB123CD", lat: 1, lng: 2 }]));
    await listDriverVehiclesFor("p@piazza.it", 1_000);
    await listDriverVehiclesFor("p@piazza.it", 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(live([{ targa: "AB123CD", lat: 3, lng: 4 }]));
    const later = await listDriverVehiclesFor("p@piazza.it", 60_000);
    expect(later[0]?.lat).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe("https://driver.test/api/cliente/en-vivo");
  });

  it("asks for a new session once when the Driver no longer accepts the old one", async () => {
    fetchMock.mockResolvedValueOnce(session("old")).mockResolvedValueOnce(live([]));
    await listDriverVehiclesFor("p@piazza.it", 1_000);
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(session("new"))
      .mockResolvedValueOnce(live([{ targa: "AB123CD", lat: 1, lng: 2 }]));
    const vehicles = await listDriverVehiclesFor("p@piazza.it", 60_000);
    expect(vehicles).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)![1].headers.Authorization).toBe("Bearer new");
  });

  it("gives no vehicles, and no error, when the Driver is down or does not know the person", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(await listDriverVehiclesFor("nobody@x.it", 1_000)).toEqual([]);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await listDriverVehiclesFor("other@x.it", 1_000)).toEqual([]);
    fetchMock.mockResolvedValueOnce(session()).mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(await listDriverVehiclesFor("noenvivo@x.it", 1_000)).toEqual([]);
  });

  it("keeps each person's list apart", async () => {
    fetchMock
      .mockResolvedValueOnce(session("a"))
      .mockResolvedValueOnce(live([{ targa: "AAA111A", lat: 1, lng: 1 }]))
      .mockResolvedValueOnce(session("b"))
      .mockResolvedValueOnce(live([{ targa: "BBB222B", lat: 2, lng: 2 }]));
    expect((await listDriverVehiclesFor("a@x.it", 1_000))[0]?.plate).toBe("AAA111A");
    expect((await listDriverVehiclesFor("b@x.it", 1_000))[0]?.plate).toBe("BBB222B");
  });
});
