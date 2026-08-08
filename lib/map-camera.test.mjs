import assert from "node:assert/strict";
import test from "node:test";
import { isUserCameraInteraction } from "./map-camera.ts";

test("manual map gestures release the followed camera", () => {
  assert.equal(isUserCameraInteraction({ originalEvent: new Event("wheel") }), true);
  assert.equal(isUserCameraInteraction({ originalEvent: new Event("touchmove") }), true);
});

test("app-driven camera movement does not disable follow mode", () => {
  assert.equal(isUserCameraInteraction({ originalEvent: undefined }), false);
  assert.equal(isUserCameraInteraction({}), false);
});
