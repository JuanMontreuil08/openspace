export type MapTheme = "light" | "dark";

/**
 * Same-origin mapcn style endpoint. The server route safely proxies CARTO's
 * public vector basemap so browser privacy filters cannot blank the map.
 */
export function getMapStyle(theme: MapTheme) {
  return theme === "dark"
    ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
}
