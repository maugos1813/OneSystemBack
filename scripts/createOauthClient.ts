/**
 * Creates the OAuth client of an app that reads vehicles with the person's consent ("Sign in with OneTrack"): by default App Piazza.
 * The client secret is printed ONCE, here, to your terminal: copy it straight to the other app's settings. It is not stored anywhere
 * (only its SHA-256 hash goes to the database), not written to a file and not logged.
 *
 *   DATABASE_URL=postgres://... npm run oauth:create-client
 *   DATABASE_URL=postgres://... npm run oauth:create-client -- --no-localhost      (leaves out the development address)
 *
 * Redirect addresses are compared EXACTLY (no wildcards). It refuses to overwrite a client that already exists.
 */
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const CLIENT_ID = "app-piazza";
const NAME = "App Piazza";
const PRODUCTION_URI = "https://app-piazza.vercel.app/mapa/onetrack/oauth";
const DEVELOPMENT_URI = "http://localhost:5174/mapa/onetrack/oauth";
const SCOPES = ["vehicles:read"];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const withLocalhost = !process.argv.includes("--no-localhost");
  const redirectUris = withLocalhost ? [PRODUCTION_URI, DEVELOPMENT_URI] : [PRODUCTION_URI];

  const secret = `ocs_${randomBytes(32).toString("base64url")}`;
  const secretHash = createHash("sha256").update(secret).digest("hex");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = await client.query("select 1 from oauth_clients where client_id = $1", [CLIENT_ID]);
    if (exists.rowCount) throw new Error(`The client "${CLIENT_ID}" already exists: nothing was changed.`);
    await client.query("insert into oauth_clients (client_id, secret_hash, name, redirect_uris, scopes) values ($1, $2, $3, $4, $5)", [
      CLIENT_ID,
      secretHash,
      NAME,
      redirectUris,
      SCOPES,
    ]);
  } finally {
    await client.end();
  }

  console.log(`\nOAuth client created.\n`);
  console.log(`  client_id:     ${CLIENT_ID}`);
  console.log(`  client_secret: ${secret}`);
  console.log(`  redirect URIs: ${redirectUris.join("\n                 ")}`);
  console.log(`  scopes:        ${SCOPES.join(" ")}`);
  console.log(`\nThe secret is shown only now. Copy it to the other app's settings; it cannot be recovered.\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
