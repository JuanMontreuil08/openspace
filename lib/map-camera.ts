type MapCameraEvent = {
  originalEvent?: unknown;
};

/** Distinguishes direct user gestures from camera changes started by the app. */
export function isUserCameraInteraction(event: MapCameraEvent) {
  return event.originalEvent != null;
}
