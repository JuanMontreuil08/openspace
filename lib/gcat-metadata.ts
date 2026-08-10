import type { GcatCatalogMetadata } from "./satellite-catalog";

type GcatObject = {
  JCAT: string;
  Type: string;
  PLName: string;
  LDate: string;
  Owner: string;
  State: string;
  Manufacturer: string;
  AltNames: string;
};

type GcatPayload = { JCAT: string; Category: string };
type GcatCurrentObject = { JCAT: string; Owner: string; State: string };
type GcatOrganization = {
  Code: string;
  ShortName: string;
  Name: string;
  ShortEName: string;
  EName: string;
  UName: string;
};

type GcatSourceTexts = {
  objects: string;
  extendedObjects: string;
  payloads: string;
  extendedPayloads: string;
  organizations: string;
  currentCatalog: string;
};

export function parseGcatTsv<T>(text: string, requiredColumns: string[]) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("#"));
  if (headerIndex === -1) throw new Error("GCAT TSV header was not found.");
  const headers = lines[headerIndex].slice(1).split("\t");
  for (const column of requiredColumns) {
    if (!headers.includes(column)) {
      throw new Error(`GCAT TSV column ${column} was not found.`);
    }
  }
  return lines
    .slice(headerIndex + 1)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const values = line.split("\t");
      return Object.fromEntries(
        headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
      ) as T;
    });
}

function usefulValue(value: string | undefined) {
  return !value || value === "-" || value === "?" ? null : value;
}

function organizationName(organization: GcatOrganization) {
  return (
    usefulValue(organization.EName) ??
    usefulValue(organization.Name) ??
    usefulValue(organization.ShortEName) ??
    usefulValue(organization.ShortName) ??
    organization.Code
  );
}

function resolveOrganizations(
  value: string | undefined,
  organizationsByCode: Map<string, GcatOrganization>,
) {
  return (usefulValue(value)?.split("/") ?? [])
    .map((code) => organizationsByCode.get(code.replace(/\?$/, "")))
    .filter((organization): organization is GcatOrganization => Boolean(organization));
}

function joinOrganizationNames(organizations: GcatOrganization[]) {
  return organizations.length > 0
    ? organizations.map(organizationName).join(" and ")
    : null;
}

function parseLaunchDate(value: string | undefined) {
  const match = usefulValue(value)?.match(
    /^(\d{4}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/,
  );
  if (!match) return null;
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ].indexOf(match[2]);
  return new Date(Date.UTC(Number(match[1]), month, Number(match[3]))).toISOString();
}

export function buildGcatMetadata(texts: GcatSourceTexts): GcatCatalogMetadata[] {
  const objects = [
    ...parseGcatTsv<GcatObject>(texts.objects, [
      "JCAT", "Type", "PLName", "LDate", "Owner", "State", "Manufacturer", "AltNames",
    ]),
    ...parseGcatTsv<GcatObject>(texts.extendedObjects, [
      "JCAT", "Type", "PLName", "LDate", "Owner", "State", "Manufacturer", "AltNames",
    ]),
  ];
  const payloadsById = new Map(
    [
      ...parseGcatTsv<GcatPayload>(texts.payloads, ["JCAT", "Category"]),
      ...parseGcatTsv<GcatPayload>(texts.extendedPayloads, ["JCAT", "Category"]),
    ].map((payload) => [payload.JCAT, payload]),
  );
  const organizationsByCode = new Map(
    parseGcatTsv<GcatOrganization>(texts.organizations, [
      "Code", "ShortName", "Name", "ShortEName", "EName", "UName",
    ]).map((organization) => [organization.Code, organization]),
  );
  const currentById = new Map(
    parseGcatTsv<GcatCurrentObject>(texts.currentCatalog, ["JCAT", "Owner", "State"])
      .map((object) => [object.JCAT, object]),
  );

  return objects.flatMap((object) => {
    if (!object.Type.trim().startsWith("P")) return [];
    const current = currentById.get(object.JCAT);
    const payload = payloadsById.get(object.JCAT);
    return [{
      jcat: object.JCAT,
      plName: usefulValue(object.PLName),
      altNames: usefulValue(object.AltNames),
      operator: joinOrganizationNames(
        resolveOrganizations(
          usefulValue(current?.Owner) ?? object.Owner,
          organizationsByCode,
        ),
      ),
      manufacturer: joinOrganizationNames(
        resolveOrganizations(object.Manufacturer, organizationsByCode),
      ),
      country: joinOrganizationNames(
        resolveOrganizations(
          usefulValue(current?.State) ?? object.State,
          organizationsByCode,
        ),
      ),
      launchDate: parseLaunchDate(object.LDate),
      missionCategory:
        usefulValue(payload?.Category)?.replaceAll("?", "").replaceAll("*", "") ?? null,
    }];
  });
}
