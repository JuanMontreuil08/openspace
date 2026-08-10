import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("clips each animated Text Roll character inside its own layout cell", () => {
  const source = readFileSync(
    new URL("../components/core/text-roll.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /inline-block overflow-hidden align-bottom/,
    "Each character must clip its outgoing transformed layer to prevent a duplicate wordmark.",
  );
});
