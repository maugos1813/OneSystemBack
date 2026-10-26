import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Radius Velocity's own driver scores: read as they come, matched to our vehicles by plate, and never a failure for the page. */

const state = vi.hoisted(() => ({ token: "t-1" as string, refreshToken: "refresh" as string | undefined }));

vi.mock("../../src/config/env.js", () => ({
  env: {
    get RADIUS_VELOCITY_REFRESH_TOKEN() {
      return state.refreshToken;
    },
    RADIUS_VELOCITY_CUSTOMER_ID: "22716414390001",
  },
}));
vi.mock("../../src/config/logger.js", () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
const radiusAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/radiusVelocity.service.js", () => ({ radiusAccessToken }));
vi.mock("../../src/db/client.js", () => ({ db: {} }));

const { fetchVelocityScores, parseVelocitySummary, clearVelocityScoresCache, reportDay } = await import("../../src/services/velocityScores.service.js");
const { applyVelocityScores } = await import("../../src/services/drivingStyle.service.js");

const row = (overrides: Record<string, unknown> = {}) => ({
  vehicle_registration: "DJ794JT",
  vehicle_group: "DHL",
  driver_score: 33,
  distance: 2226.3,
  duration: 134269,
  number_of_journeys: 101,
  braking_score: 46,
  speeding_score: 12,
  accelerating_score: 55,
  cornering_score: 19,
  braking_event_count: 39,
  speeding_event_count: 201,
  accelerating_event_count: 60,
  cornering_event_count: 62,
  ...overrides,
});

describe("reading Velocity's summary", () => {
  it("turns each vehicle's row into its scores, hours and event counts", () => {
    const scores = parseVelocitySummary({ summaries: [row(), row({ vehicle_registration: "fb 390 pr", driver_score: 50 })] });
    expect(scores.get("DJ794JT")).toEqual({
      plate: "DJ794JT",
      group: "DHL",
      distanceKm: 2226.3,
      drivingHours: 134269 / 3600,
      trips: 101,
      overall: 33,
      braking: 46,
      acceleration: 55,
      cornering: 19,
      speeding: 12,
      events: { braking: 39, acceleration: 60, cornering: 62, speeding: 201 },
    });
    expect(scores.get("FB390PR")?.overall).toBe(50);
  });

  it("ignores rows that are not a vehicle with a score, and anything that is not a summary", () => {
    expect(parseVelocitySummary({ summaries: [{ vehicle_registration: "", driver_score: 1 }, { vehicle_registration: "X", driver_score: "n/a" }, null] }).size).toBe(0);
    expect(parseVelocitySummary({ nope: true }).size).toBe(0);
    expect(parseVelocitySummary(null).size).toBe(0);
  });

  it("names the calendar day in Rome, whatever hour of the night it is in UTC", () => {
    expect(reportDay(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
    expect(reportDay(new Date("2026-10-26T12:00:00Z"))).toBe("2026-10-26");
  });
});

describe("asking Velocity", () => {
  const fetchMock = vi.fn();
  const FROM = new Date("2026-10-19T10:00:00Z");
  const TO = new Date("2026-10-26T10:00:00Z");
  beforeEach(() => {
    clearVelocityScoresCache();
    fetchMock.mockReset();
    radiusAccessToken.mockReset().mockResolvedValue("t-1");
    state.refreshToken = "refresh";
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the date range and the account, and remembers the answer for a few minutes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ summaries: [row()] }), { status: 200 }));
    const first = await fetchVelocityScores(FROM, TO, 1_000);
    expect(first?.get("DJ794JT")?.overall).toBe(33);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.velocityfleet.com/vapi/v2/telematics/driver-performance/scores/summary/");
    expect(init.headers.Authorization).toBe("Bearer t-1");
    expect(JSON.parse(init.body)).toMatchObject({
      customers: ["22716414390001"],
      all_drivers: true,
      all_devices: true,
      date_selection_type: 2,
      date_start: "2026-10-19",
      date_end: "2026-10-26",
    });
    await fetchVelocityScores(FROM, TO, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchVelocityScores(FROM, TO, 400_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for a new session once when Velocity does not accept the old one", async () => {
    radiusAccessToken.mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ summaries: [row()] }), { status: 200 }));
    expect((await fetchVelocityScores(FROM, TO, 1_000))?.size).toBe(1);
    expect(radiusAccessToken).toHaveBeenLastCalledWith({ fresh: true });
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe("Bearer new");
  });

  it("gives null — not an error — when Velocity is not configured, fails or is unreachable", async () => {
    state.refreshToken = undefined;
    expect(await fetchVelocityScores(FROM, TO, 1_000)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    state.refreshToken = "refresh";
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await fetchVelocityScores(FROM, TO, 1_000)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchVelocityScores(new Date("2026-10-01T10:00:00Z"), TO, 1_000)).toBeNull();
  });
});

describe("putting Velocity's numbers on the vehicles", () => {
  const own = (plate: string | null) => ({
    vehicleId: plate ?? "x",
    name: plate ?? "x",
    plate,
    fleetGroup: "DHL",
    source: "onetrack" as const,
    scoring: "per_100km" as const,
    samples: 500,
    distanceKm: 10,
    drivingHours: 1,
    trips: 1,
    quality: "insufficient_data" as const,
    scores: null,
    incidents: { harshBraking: 1, harshAcceleration: 1, harshCornering: 1, speeding: 1 },
    incidentsPer100Km: null,
  });

  it("replaces the scores, counts, hours and distance of a vehicle Velocity reports, matched by plate", () => {
    const velocity = parseVelocitySummary({ summaries: [row()] });
    const [matched, other, noPlate] = applyVelocityScores([own("DJ 794 JT"), own("ZZ999ZZ"), own(null)], velocity);
    expect(matched).toMatchObject({
      source: "velocity",
      quality: "full",
      distanceKm: 2226.3,
      drivingHours: 37.3,
      trips: 101,
      scores: { overall: 33, harshBraking: 46, harshAcceleration: 55, harshCornering: 19, speeding: 12, grade: "D" },
      incidents: { harshBraking: 39, harshAcceleration: 60, harshCornering: 62, speeding: 201 },
      incidentsPer100Km: null,
    });
    expect(other?.source).toBe("onetrack");
    expect(noPlate?.source).toBe("onetrack");
  });
});
