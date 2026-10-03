/**
 * One-off (re-runnable) import of Italy's toll stations from OpenStreetMap into
 * `toll_plazas`. Clusters the several lane nodes OSM draws per station into one point.
 * The app never calls Overpass at runtime — this is the only place that does.
 *
 * Usage: DATABASE_URL=postgres://... npm run seed:tolls
 * Data © OpenStreetMap contributors (ODbL).
 */
import pg from "pg";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const CLUSTER_RADIUS_M = 250;
const UNNAMED = "Peaje sin identificar";

interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface Cluster {
  nodes: OsmNode[];
  lat: number;
  lng: number;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * 111_320;
  const dLng = (bLng - aLng) * 111_320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng);
}

function normalizeName(name: string | undefined): string | undefined {
  return name?.trim().toLowerCase() || undefined;
}

function clusterName(cluster: Cluster): string | undefined {
  return cluster.nodes.map((n) => n.tags.name?.trim()).find((n): n is string => !!n);
}

/** A node joins a cluster only if it's close to it and doesn't contradict its name —
 * two differently named stations that happen to be near each other stay separate. */
function namesCompatible(cluster: Cluster, node: OsmNode): boolean {
  const existing = normalizeName(clusterName(cluster));
  const incoming = normalizeName(node.tags.name);
  return !existing || !incoming || existing === incoming;
}

function buildClusters(nodes: OsmNode[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const node of [...nodes].sort((a, b) => a.id - b.id)) {
    const home = clusters.find(
      (c) => distanceMeters(c.lat, c.lng, node.lat, node.lon) <= CLUSTER_RADIUS_M && namesCompatible(c, node),
    );
    if (!home) {
      clusters.push({ nodes: [node], lat: node.lat, lng: node.lon });
      continue;
    }
    home.nodes.push(node);
    home.lat = home.nodes.reduce((sum, n) => sum + n.lat, 0) / home.nodes.length;
    home.lng = home.nodes.reduce((sum, n) => sum + n.lon, 0) / home.nodes.length;
  }
  return clusters;
}

async function overpass<T>(query: string): Promise<T[]> {
  // The public Overpass servers are shared and sometimes answer 429/504 under load.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": "OneSystem-toll-seed/1.0", Accept: "application/json" },
      body: new URLSearchParams({ data: query }),
    });
    if (res.ok) return ((await res.json()) as { elements: T[] }).elements;
    if (attempt === 4) throw new Error(`Overpass request failed: HTTP ${res.status}`);
    console.log(`Overpass HTTP ${res.status}, retrying (${attempt}/3)...`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
  }
}

const ITALY = '[out:json][timeout:180];area["ISO3166-1"="IT"]->.it;';

/**
 * OSM also tags parking-lot, airport and private-road barriers as toll booths. A real toll
 * station is either named by the mapper or sits on a motorway/trunk road, so everything
 * else is dropped here rather than being detected (and reported) as a toll later.
 */
async function fetchItalianTollNodes(): Promise<OsmNode[]> {
  const all = await overpass<OsmNode>(
    `${ITALY}(node["barrier"="toll_booth"](area.it);node["highway"="toll_gantry"](area.it););out body;`,
  );
  const onMajorRoad = new Set(
    (
      await overpass<{ id: number }>(
        `${ITALY}node["barrier"="toll_booth"](area.it)->.tb;` +
          'way(bn.tb)["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"]->.mw;node.tb(w.mw);out ids;',
      )
    ).map((n) => n.id),
  );
  return all.filter((n) => n.tags.name?.trim() || onMajorRoad.has(n.id));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const nodes = await fetchItalianTollNodes();
  const clusters = buildClusters(nodes);
  console.log(`${nodes.length} OSM nodes -> ${clusters.length} toll stations`);

  const rows = clusters.map((c) => ({
    osmKey: String(Math.min(...c.nodes.map((n) => n.id))),
    name: (clusterName(c) ?? UNNAMED).slice(0, 150),
    operator: c.nodes.map((n) => n.tags.operator?.trim()).find((o): o is string => !!o)?.slice(0, 150) ?? null,
    lat: c.lat,
    lng: c.lng,
    points: JSON.stringify(c.nodes.map((n) => [n.lat, n.lon])),
  }));

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO toll_plazas (osm_key, name, operator, lat, lng, points)
       SELECT k, n, o, la, ln, p::jsonb
       FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::text[]) AS t(k, n, o, la, ln, p)
       ON CONFLICT (osm_key) DO UPDATE
         SET name = EXCLUDED.name, operator = EXCLUDED.operator, lat = EXCLUDED.lat,
             lng = EXCLUDED.lng, points = EXCLUDED.points`,
      [
        rows.map((r) => r.osmKey),
        rows.map((r) => r.name),
        rows.map((r) => r.operator),
        rows.map((r) => r.lat),
        rows.map((r) => r.lng),
        rows.map((r) => r.points),
      ],
    );
    // Drop stations that disappeared from OSM, but never one that has recorded passages
    // (deleting it would cascade-delete that history).
    const removed = await client.query(
      `DELETE FROM toll_plazas
       WHERE osm_key <> ALL($1::text[]) AND id NOT IN (SELECT plaza_id FROM toll_passages)`,
      [rows.map((r) => r.osmKey)],
    );
    await client.query("COMMIT");
    console.log(`Upserted ${rows.length} stations, removed ${removed.rowCount ?? 0} stale ones.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
