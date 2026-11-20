import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const pg = new PGlite();
const VELOCITY = "00000000-0000-0000-0000-000000000001";
const TELTONIKA = "00000000-0000-0000-0000-000000000002";

const at = async (table: string, device: string) =>
  (await pg.query<{ ts: string }>(`SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts FROM ${table} WHERE device_id = '${device}' ORDER BY ts`)).rows.map((r) => r.ts);

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY, source varchar(20) NOT NULL DEFAULT 'teltonika', last_seen_at timestamptz);
    CREATE TABLE positions (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL DEFAULT 0, lng double precision NOT NULL DEFAULT 0, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0, priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
    CREATE TABLE device_events (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, type varchar(50) NOT NULL DEFAULT 'ignition_change', payload jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
    INSERT INTO devices (id, source, last_seen_at) VALUES
      ('${VELOCITY}', 'radius_velocity', '2026-11-20T14:35:00Z'),
      ('${TELTONIKA}', 'teltonika', '2026-11-20T13:35:00Z');
    INSERT INTO positions (device_id, ts) VALUES
      ('${VELOCITY}', '2026-11-20T14:35:00Z'),
      ('${VELOCITY}', '2026-07-14T14:35:00Z'),
      ('${TELTONIKA}', '2026-11-20T13:35:00Z');
    INSERT INTO device_events (device_id, ts) VALUES ('${VELOCITY}', '2026-11-20T14:35:00Z'), ('${TELTONIKA}', '2026-11-20T13:35:00Z');
  `);
  // The REAL migration (its Timescale part is skipped where the extension does not exist, as here).
  for (const statement of readFileSync("drizzle/0050_velocity_clock_to_utc.sql", "utf8").split("--> statement-breakpoint")) await pg.exec(statement);
});

describe("0050: Radius Velocity times become the real instant", () => {
  it("takes 1 h off in winter (14:35 -> 13:35 UTC) and 2 h in summer (14:35 -> 12:35 UTC)", async () => {
    expect(await at("positions", VELOCITY)).toEqual(["2026-07-14T12:35:00Z", "2026-11-20T13:35:00Z"]);
  });
  it("shifts the events and the last-seen the same way", async () => {
    expect(await at("device_events", VELOCITY)).toEqual(["2026-11-20T13:35:00Z"]);
    const { rows } = await pg.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM devices WHERE id = '${VELOCITY}'`);
    expect(rows[0]!.last_seen_at.toISOString()).toBe("2026-11-20T13:35:00.000Z");
  });
  it("leaves Teltonika devices alone", async () => {
    expect(await at("positions", TELTONIKA)).toEqual(["2026-11-20T13:35:00Z"]);
    expect(await at("device_events", TELTONIKA)).toEqual(["2026-11-20T13:35:00Z"]);
    const { rows } = await pg.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM devices WHERE id = '${TELTONIKA}'`);
    expect(rows[0]!.last_seen_at.toISOString()).toBe("2026-11-20T13:35:00.000Z");
  });
});
