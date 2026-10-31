import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Documents that expire (seguro, revisione, bollo, tacógrafo…): status, who can touch them, and who is alerted. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { documentStatus, documentName, documentAlertMessage } = await import("../../src/services/vehicleDocuments.js");
const service = await import("../../src/services/vehicleDocument.service.js");
const { alertsForRecipient } = await import("../../src/services/alertRecipients.js");
const { vehicles, vehicleDocuments } = await import("../../src/db/schema/index.js");
const { db } = clientModule;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const PIAZZA_VEHICLE = "00000000-0000-0000-0000-0000000000c1";
const DHL_VEHICLE = "00000000-0000-0000-0000-0000000000c2";
const NOW = new Date("2026-10-24T15:30:00Z");

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20),
      device_id uuid, fleet_group varchar(50), odometer_offset_km integer NOT NULL DEFAULT 0, brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text, odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz, km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE vehicle_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, vehicle_id uuid NOT NULL, kind varchar(30) NOT NULL,
      label varchar(100), expires_on date NOT NULL, remind_days integer NOT NULL DEFAULT 30, notes text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});
afterAll(async () => {
  await clientModule.__pg.close();
});
beforeEach(async () => {
  await db.delete(vehicleDocuments);
  await db.delete(vehicles);
  await db.insert(vehicles).values([
    { id: PIAZZA_VEHICLE, orgId: ORG, name: "Furgone Piazza", plate: "PZ111AA", fleetGroup: "PIAZZA" },
    { id: DHL_VEHICLE, orgId: ORG, name: "Furgone DHL", plate: "DH222BB", fleetGroup: "DHL" },
  ]);
});

describe("documentStatus", () => {
  it("is ok well before, soon inside the warning window, valid on the day, overdue after", () => {
    expect(documentStatus("2026-12-31", 30, NOW)).toEqual({ state: "ok", daysLeft: 68 });
    expect(documentStatus("2026-11-23", 30, NOW)).toEqual({ state: "soon", daysLeft: 30 });
    expect(documentStatus("2026-11-24", 30, NOW)).toEqual({ state: "ok", daysLeft: 31 });
    expect(documentStatus("2026-10-24", 30, NOW)).toEqual({ state: "soon", daysLeft: 0 });
    expect(documentStatus("2026-10-23", 30, NOW)).toEqual({ state: "overdue", daysLeft: -1 });
  });

  it("counts calendar days, whatever the time of day", () => {
    expect(documentStatus("2026-10-25", 30, new Date("2026-10-24T23:59:00Z")).daysLeft).toBe(1);
    expect(documentStatus("2026-10-25", 30, new Date("2026-10-24T00:01:00Z")).daysLeft).toBe(1);
  });

  it("uses each document's own warning days", () => {
    expect(documentStatus("2026-11-10", 7, NOW).state).toBe("ok");
    expect(documentStatus("2026-11-10", 20, NOW).state).toBe("soon");
  });

  it("names a document and words its alert", () => {
    expect(documentName("seguro", null)).toBe("Seguro");
    expect(documentName("otro", "Licencia ZTL")).toBe("Licencia ZTL");
    expect(documentAlertMessage("Furgone", "Seguro", { state: "soon", daysLeft: 5 })).toBe("Furgone: Seguro vence en 5 días");
    expect(documentAlertMessage("Furgone", "Seguro", { state: "soon", daysLeft: 0 })).toBe("Furgone: Seguro vence hoy");
    expect(documentAlertMessage("Furgone", "Seguro", { state: "overdue", daysLeft: -3 })).toBe("Furgone: Seguro vencido hace 3 días");
    expect(documentAlertMessage("Furgone", "Assicurazione", { state: "soon", daysLeft: 5 }, "it")).toBe("Furgone: Assicurazione — scade tra 5 giorni");
    expect(documentAlertMessage("Furgone", "Assicurazione", { state: "soon", daysLeft: 1 }, "it")).toBe("Furgone: Assicurazione — scade tra 1 giorno");
    expect(documentAlertMessage("Furgone", "Assicurazione", { state: "soon", daysLeft: 0 }, "it")).toBe("Furgone: Assicurazione — scade oggi");
    expect(documentAlertMessage("Furgone", "Assicurazione", { state: "overdue", daysLeft: -3 }, "it")).toBe("Furgone: Assicurazione — scadenza superata da 3 giorni");
  });
});

describe("the documents of a vehicle", () => {
  it("are created, listed with their status and edited", async () => {
    const created = await service.createDocument(ORG, "PIAZZA", PIAZZA_VEHICLE, { kind: "seguro", expiresOn: "2026-11-10" }, NOW);
    expect(created).toMatchObject({ name: "Seguro", status: { state: "soon", daysLeft: 17 }, remindDays: 30 });

    const [piazza] = await service.listVehicleDocuments(ORG, "PIAZZA", NOW);
    expect(piazza).toMatchObject({ name: "Furgone Piazza", plate: "PZ111AA" });
    expect(piazza!.documents).toHaveLength(1);

    const edited = await service.updateDocument(ORG, "PIAZZA", created.id, { expiresOn: "2027-10-10", notes: "Renovado" }, NOW);
    expect(edited).toMatchObject({ status: { state: "ok" }, notes: "Renovado" });
  });

  it("an 'otro' needs a name, and the name is dropped when it becomes a known kind", async () => {
    await expect(service.createDocument(ORG, "PIAZZA", PIAZZA_VEHICLE, { kind: "otro", expiresOn: "2027-01-01" }, NOW)).rejects.toMatchObject({ status: 400 });
    const doc = await service.createDocument(ORG, "PIAZZA", PIAZZA_VEHICLE, { kind: "otro", label: " Licencia ZTL ", expiresOn: "2027-01-01" }, NOW);
    expect(doc).toMatchObject({ name: "Licencia ZTL", label: "Licencia ZTL" });
    expect(await service.updateDocument(ORG, "PIAZZA", doc.id, { kind: "bollo" }, NOW)).toMatchObject({ name: "Bollo", label: null });
  });

  it("show a client only the vehicles of their own flota", async () => {
    await service.createDocument(ORG, null, PIAZZA_VEHICLE, { kind: "seguro", expiresOn: "2027-01-01" }, NOW);
    await service.createDocument(ORG, null, DHL_VEHICLE, { kind: "seguro", expiresOn: "2027-01-01" }, NOW);
    expect((await service.listVehicleDocuments(ORG, "PIAZZA", NOW)).map((v) => v.name)).toEqual(["Furgone Piazza"]);
    expect((await service.listVehicleDocuments(ORG, null, NOW)).map((v) => v.name)).toEqual(["Furgone DHL", "Furgone Piazza"]);
  });

  it("cannot be added, changed or removed on a vehicle outside the client's flota, or of another organization", async () => {
    await expect(service.createDocument(ORG, "PIAZZA", DHL_VEHICLE, { kind: "seguro", expiresOn: "2027-01-01" }, NOW)).rejects.toMatchObject({ status: 404 });
    const dhlDoc = await service.createDocument(ORG, null, DHL_VEHICLE, { kind: "seguro", expiresOn: "2027-01-01" }, NOW);
    await expect(service.updateDocument(ORG, "PIAZZA", dhlDoc.id, { notes: "x" }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteDocument(ORG, "PIAZZA", dhlDoc.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteDocument(OTHER_ORG, null, dhlDoc.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.listDocumentsForOrg(ORG)).toHaveLength(1);
  });

  it("are deleted", async () => {
    const doc = await service.createDocument(ORG, "PIAZZA", PIAZZA_VEHICLE, { kind: "bollo", expiresOn: "2027-01-01" }, NOW);
    await service.deleteDocument(ORG, "PIAZZA", doc.id);
    expect(await service.listDocumentsForOrg(ORG)).toHaveLength(0);
  });
});

describe("who is told about an alert", () => {
  const items = [
    { vehicleName: "Piazza 1", message: { es: "a", it: "a" }, fleetGroup: "PIAZZA" },
    { vehicleName: "DHL 1", message: { es: "b", it: "b" }, fleetGroup: "DHL" },
    { vehicleName: "Sin flota", message: { es: "c", it: "c" }, fleetGroup: null },
  ];

  it("gives the owner everything, and a client only their own flota's", () => {
    expect(alertsForRecipient(items, { userId: "u0", email: "owner@x.it", language: "es", fleetGroup: null })).toHaveLength(3);
    expect(alertsForRecipient(items, { userId: "u1", email: "p@x.it", language: "it", fleetGroup: "PIAZZA" }).map((i) => i.vehicleName)).toEqual(["Piazza 1"]);
    expect(alertsForRecipient(items, { userId: "u2", email: "d@x.it", language: "es", fleetGroup: "DHL" }).map((i) => i.vehicleName)).toEqual(["DHL 1"]);
  });

  it("never gives a client an alert about a vehicle with no flota, or with an untagged alert", () => {
    expect(alertsForRecipient([{ vehicleName: "x", message: { es: "y", it: "y" } }], { userId: "u1", email: "p@x.it", language: "it", fleetGroup: "PIAZZA" })).toEqual([]);
    expect(alertsForRecipient([items[2]!], { userId: "u1", email: "p@x.it", language: "it", fleetGroup: "PIAZZA" })).toEqual([]);
  });
});
