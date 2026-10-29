/**
 * Loads Rome's limited-traffic zones (ZTL) into an organization's geofences, from scripts/data/romaZtl.json (official
 * open data of Roma Servizi per la Mobilità: data-rsm.opendata.arcgis.com, licences in the file).
 *
 * Safe by design: it only ever INSERTS, skips any zone whose name the org already has (so it can be re-run), and does
 * nothing at all unless --apply is given — without it, it prints what it would add.
 *
 * Usage: DATABASE_URL=postgres://... npm run seed:ztl-roma -- --org "<organization name or id>" [--apply]
 *        npm run seed:ztl-roma -- --org "<organization name>" --sql > ztl.sql   (no database needed: prints the same inserts
 *        as SQL, each guarded so it adds nothing that already exists, to run with psql where the database is reachable)
 */
import { readFileSync } from "node:fs";
import pg from "pg";

interface Zone {
  name: string;
  description: string;
  alertOnEnter: boolean;
  alertOnExit: boolean;
  license: string;
  path: Array<Array<{ lat: number; lng: number }>>;
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const orgArg = args[args.indexOf("--org") + 1];

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

function printSql(zones: Zone[], org: string): void {
  const orgId = `(SELECT id FROM organizations WHERE name = ${quote(org)} OR id::text = ${quote(org)})`;
  console.log("BEGIN;");
  for (const z of zones) {
    console.log(
      `INSERT INTO geofences (org_id, name, type, path, alert_on_enter, alert_on_exit)\n` +
        `SELECT ${orgId}, ${quote(z.name)}, 'polygon', $json$${JSON.stringify(z.path)}$json$::jsonb, ${z.alertOnEnter}, ${z.alertOnExit}\n` +
        `WHERE ${orgId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM geofences WHERE org_id = ${orgId} AND name = ${quote(z.name)});`,
    );
  }
  console.log("COMMIT;");
}

async function main(): Promise<void> {
  if (args.indexOf("--org") < 0 || !orgArg || orgArg.startsWith("--")) throw new Error('--org "<name or id>" is required');

  const data = JSON.parse(readFileSync(new URL("./data/romaZtl.json", import.meta.url), "utf8")) as { zones: Zone[] };
  if (args.includes("--sql")) return printSql(data.zones, orgArg);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const orgs = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM organizations WHERE id::text = $1 OR name = $1",
      [orgArg],
    );
    if (orgs.rowCount !== 1) throw new Error(`Expected exactly one organization for "${orgArg}", found ${orgs.rowCount}`);
    const org = orgs.rows[0]!;

    const existing = new Set(
      (await client.query<{ name: string }>("SELECT name FROM geofences WHERE org_id = $1", [org.id])).rows.map((r) => r.name),
    );
    const toAdd = data.zones.filter((z) => !existing.has(z.name));

    console.log(`Organization: ${org.name} (${org.id})`);
    for (const z of data.zones) {
      const vertices = z.path.reduce((n, ring) => n + ring.length, 0);
      const flags = `enter alert: ${z.alertOnEnter ? "yes" : "no"}`;
      console.log(`  ${existing.has(z.name) ? "= already there" : "+ add          "}  ${z.name}  (${z.path.length} ring(s), ${vertices} vertices, ${flags})`);
    }
    if (toAdd.length === 0) return void console.log("Nothing to add.");
    if (!apply) return void console.log(`\nDry run: ${toAdd.length} zone(s) would be added. Re-run with --apply to insert them.`);

    await client.query("BEGIN");
    for (const z of toAdd) {
      await client.query(
        `INSERT INTO geofences (org_id, name, type, path, alert_on_enter, alert_on_exit) VALUES ($1, $2, 'polygon', $3::jsonb, $4, $5)`,
        [org.id, z.name, JSON.stringify(z.path), z.alertOnEnter, z.alertOnExit],
      );
    }
    await client.query("COMMIT");
    console.log(`\nAdded ${toAdd.length} zone(s).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
