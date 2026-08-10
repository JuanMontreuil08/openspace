"use client";

import {
  Map as MapLibreMapConstructor,
  type Map as MapLibreMap,
  type MapOptions,
  type ProjectionSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { getMapStyle } from "@/lib/map-style";

export type MapRef = MapLibreMap;

type MapProps = {
  center: [number, number];
  zoom?: number;
  theme: "light" | "dark";
  projection?: ProjectionSpecification;
  className?: string;
  onReady?: (map: MapLibreMap) => void;
} & Omit<MapOptions, "container" | "style" | "center" | "zoom">;

export const Map = forwardRef<MapRef, MapProps>(function Map(
  {
    center,
    zoom = 4,
    theme,
    projection = { type: "mercator" },
    className,
    onReady,
    ...options
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onReadyRef = useRef(onReady);
  const appliedThemeRef = useRef(theme);
  const [loading, setLoading] = useState(true);

  onReadyRef.current = onReady;
  useImperativeHandle(forwardedRef, () => mapRef.current as MapLibreMap, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMapConstructor({
      container: containerRef.current,
      style: getMapStyle(theme),
      center,
      zoom,
      renderWorldCopies: false,
      attributionControl: { compact: true },
      ...options,
    });

    mapRef.current = map;
    let ready = false;
    const handleError = (event: { error?: Error }) => {
      console.error("[COOPER map]", event.error?.message ?? "Unknown map error");
    };
    const handleLoad = () => {
      if (ready) return;
      ready = true;
      map.setProjection(projection);
      setLoading(false);
      onReadyRef.current?.(map);
    };
    map.on("load", handleLoad);
    map.on("style.load", handleLoad);
    map.on("error", handleError);

    return () => {
      map.off("load", handleLoad);
      map.off("style.load", handleLoad);
      map.off("error", handleError);
      map.remove();
      mapRef.current = null;
    };
    // Map options are intentionally initialization-only, matching mapcn's Map API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (appliedThemeRef.current === theme) return;
    const applyTheme = () => {
      appliedThemeRef.current = theme;
      setLoading(true);
      map.setStyle(getMapStyle(theme), { diff: false });
      map.once("style.load", () => {
        setLoading(false);
        onReadyRef.current?.(map);
      });
    };
    if (map.isStyleLoaded()) {
      applyTheme();
      return;
    }
    map.once("load", applyTheme);
    return () => {
      map.off("load", applyTheme);
    };
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyProjection = () => map.setProjection(projection);
    if (map.isStyleLoaded()) {
      applyProjection();
      return;
    }
    map.once("style.load", applyProjection);
    return () => {
      map.off("style.load", applyProjection);
    };
  }, [projection]);

  return (
    <div className={`mapcn-map${className ? ` ${className}` : ""}`}>
      <div ref={containerRef} className="mapcn-map-canvas" />
      {loading && (
        <div className="mapcn-map-loader" aria-label="Loading map">
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
});
