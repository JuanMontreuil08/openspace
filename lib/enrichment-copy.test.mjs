import assert from "node:assert/strict";
import test from "node:test";

import { enrichmentPrompt } from "./enrichment-copy.ts";

test("asks only for the operator description when the mission is present", () => {
  assert.equal(
    enrichmentPrompt({
      hasMissionDescription: true,
      hasOperatorName: true,
      hasOperatorDescription: false,
    }),
    "Operator description is not available yet. Select Enhance with AI to research it.",
  );
});

test("asks only for the mission when operator details are present", () => {
  assert.equal(
    enrichmentPrompt({
      hasMissionDescription: false,
      hasOperatorName: true,
      hasOperatorDescription: true,
    }),
    "Mission description is not available yet. Select Enhance with AI to research it.",
  );
});

test("explains when both operator name and description are missing", () => {
  assert.equal(
    enrichmentPrompt({
      hasMissionDescription: true,
      hasOperatorName: false,
      hasOperatorDescription: false,
    }),
    "Operator name and description are not available from the direct catalog sources. Select Enhance with AI to research them.",
  );
});
