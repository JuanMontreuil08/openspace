import assert from "node:assert/strict";
import test from "node:test";

import { buildGcatMetadata } from "./gcat-metadata.ts";

function tsv(headers, rows = []) {
  return [`#${headers.join("\t")}`, ...rows.map((row) => row.join("\t"))].join("\n");
}

test("GCAT current ownership overrides historical ownership", () => {
  const metadata = buildGcatMetadata({
    objects: tsv(
      ["JCAT", "Type", "PLName", "LDate", "Owner", "State", "Manufacturer", "AltNames"],
      [["S00001", "P", "Payload One", "2026 Jan 2", "OLD", "US", "MFG", "Alias"]],
    ),
    extendedObjects: tsv(
      ["JCAT", "Type", "PLName", "LDate", "Owner", "State", "Manufacturer", "AltNames"],
    ),
    payloads: tsv(["JCAT", "Category"], [["S00001", "Communications?"]]),
    extendedPayloads: tsv(["JCAT", "Category"]),
    organizations: tsv(
      ["Code", "ShortName", "Name", "ShortEName", "EName", "UName"],
      [
        ["OLD", "Old", "Old Operator", "-", "-", "-"],
        ["NEW", "New", "New Operator", "-", "-", "-"],
        ["US", "US", "United States", "-", "-", "-"],
        ["MFG", "Maker", "Manufacturer", "-", "-", "-"],
      ],
    ),
    currentCatalog: tsv(["JCAT", "Owner", "State"], [["S00001", "NEW", "US"]]),
  });

  assert.equal(metadata[0].operator, "New Operator");
  assert.equal(metadata[0].manufacturer, "Manufacturer");
  assert.equal(metadata[0].country, "United States");
  assert.equal(metadata[0].missionCategory, "Communications");
});

test("GCAT blank current ownership falls back to historical metadata", () => {
  const headers = ["JCAT", "Type", "PLName", "LDate", "Owner", "State", "Manufacturer", "AltNames"];
  const metadata = buildGcatMetadata({
    objects: tsv(headers, [["S00001", "P", "Payload", "2026 Jan 2", "OLD", "US", "-", "-"]]),
    extendedObjects: tsv(headers),
    payloads: tsv(["JCAT", "Category"], [["S00001", "Science"]]),
    extendedPayloads: tsv(["JCAT", "Category"]),
    organizations: tsv(
      ["Code", "ShortName", "Name", "ShortEName", "EName", "UName"],
      [["OLD", "Old", "Historical Operator", "-", "-", "-"], ["US", "US", "United States", "-", "-", "-"]],
    ),
    currentCatalog: tsv(["JCAT", "Owner", "State"], [["S00001", "-", "?"]]),
  });
  assert.equal(metadata[0].operator, "Historical Operator");
  assert.equal(metadata[0].country, "United States");
});
