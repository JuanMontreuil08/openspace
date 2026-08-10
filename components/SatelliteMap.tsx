"use client";

import type { Feature, MultiLineString } from "geojson";
import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
} from "maplibre-gl";
import { Minus, Plus, Scan } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Map } from "@/components/ui/map";
import type {
  GroundTrackPoint,
  GroundTrackSample,
} from "@/lib/ground-track";
import { isUserCameraInteraction } from "@/lib/map-camera";

type SatelliteMapProps = {
  current: GroundTrackPoint | null;
  past: GroundTrackSample[];
  predicted: GroundTrackSample[];
  inspected: GroundTrackSample | null;
  inspectionLabel: string | null;
  satelliteName: string;
  theme: "light" | "dark";
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  onReturnToLive: () => void;
};

const PAST_SOURCE = "satellite-track-past";
const FUTURE_SOURCE = "satellite-track-future";
const PAST_LAYER = "satellite-track-past-line";
const FUTURE_LAYER = "satellite-track-future-line";
function splitAtAntimeridian(points: GroundTrackPoint[]): number[][][] {
  if (points.length < 2) return [];
  const lines: number[][][] = [];
  let line: number[][] = [[points[0].longitude, points[0].latitude]];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (Math.abs(point.longitude - previous.longitude) > 180) {
      if (line.length > 1) lines.push(line);
      line = [];
    }
    line.push([point.longitude, point.latitude]);
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

function trackFeature(points: GroundTrackPoint[]): Feature<MultiLineString> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiLineString",
      coordinates: splitAtAntimeridian(points),
    },
  };
}

function addOrUpdateTrack(
  map: MapLibreMap,
  sourceId: string,
  layerId: string,
  points: GroundTrackPoint[],
  predicted: boolean,
) {
  const data = trackFeature(points);
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(sourceId, { type: "geojson", data });
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": predicted ? "#86a1ae" : "#69dcff",
      "line-width": predicted ? 2 : 3,
      "line-opacity": predicted ? 0.85 : 1,
      ...(predicted ? { "line-dasharray": [3, 3] } : {}),
    },
  });
}

export function SatelliteMap({
  current,
  past,
  predicted,
  inspected,
  inspectionLabel,
  satelliteName,
  theme,
  follow,
  onFollowChange,
  onReturnToLive,
}: SatelliteMapProps) {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const markerElementRef = useRef<HTMLDivElement | null>(null);
  const markerLabelRef = useRef<HTMLSpanElement | null>(null);
  const liveMarkerRef = useRef<Marker | null>(null);
  const liveMarkerElementRef = useRef<HTMLDivElement | null>(null);
  const trackDataRef = useRef({ past, predicted });
  const displayPoint = inspected ?? current ?? { latitude: 0, longitude: 0 };
  const latitude = displayPoint.latitude;
  const longitude = displayPoint.longitude;

  useEffect(() => {
    trackDataRef.current = { past, predicted };
  }, [past, predicted]);

  const syncLayers = useCallback((target: MapLibreMap) => {
    addOrUpdateTrack(
      target,
      PAST_SOURCE,
      PAST_LAYER,
      trackDataRef.current.past,
      false,
    );
    addOrUpdateTrack(
      target,
      FUTURE_SOURCE,
      FUTURE_LAYER,
      trackDataRef.current.predicted,
      true,
    );
  }, []);

  const handleReady = useCallback(
    (readyMap: MapLibreMap) => {
      setMap(readyMap);
      syncLayers(readyMap);
    },
    [syncLayers],
  );

  useEffect(() => {
    if (!map) return;
    syncLayers(map);
  }, [map, past, predicted, syncLayers]);

  useEffect(() => {
    if (!map) return;
    const element = document.createElement("div");
    element.className = "tracked-satellite-marker";
    const glyph = document.createElement("span");
    glyph.className = "satellite-glyph";
    glyph.setAttribute("aria-hidden", "true");
    for (const className of [
      "satellite-panel-left",
      "satellite-body",
      "satellite-panel-right",
    ]) {
      const part = document.createElement("i");
      part.className = className;
      glyph.appendChild(part);
    }
    const label = document.createElement("span");
    label.className = "satellite-map-label";
    label.textContent = satelliteName;
    element.append(glyph, label);
    const marker = new Marker({ element, anchor: "center" })
      .setLngLat([0, 0])
      .addTo(map);
    markerRef.current = marker;
    markerElementRef.current = element;
    markerLabelRef.current = label;

    const liveElement = document.createElement("div");
    liveElement.className = "live-satellite-position-marker";
    liveElement.setAttribute("aria-label", "Live satellite position");
    liveElement.title = "Live satellite position";
    const liveMarker = new Marker({ element: liveElement, anchor: "center" })
      .setLngLat([0, 0])
      .addTo(map);
    liveMarkerRef.current = liveMarker;
    liveMarkerElementRef.current = liveElement;

    return () => {
      marker.remove();
      liveMarker.remove();
      markerRef.current = null;
      markerElementRef.current = null;
      markerLabelRef.current = null;
      liveMarkerRef.current = null;
      liveMarkerElementRef.current = null;
    };
  }, [map, satelliteName]);

  useEffect(() => {
    if (markerLabelRef.current) {
      markerLabelRef.current.textContent = inspectionLabel
        ? `${satelliteName} · ${inspectionLabel}`
        : satelliteName;
    }
    markerElementRef.current?.classList.toggle("is-inspecting", Boolean(inspected));
    markerElementRef.current?.classList.toggle("is-position-unavailable", !current);
    liveMarkerElementRef.current?.classList.toggle("is-visible", Boolean(inspected));
  }, [current, inspected, inspectionLabel, satelliteName]);

  useEffect(() => {
    if (!map) return;
    const stopFollowing = (event: { originalEvent?: unknown }) => {
      if (isUserCameraInteraction(event)) onFollowChange(false);
    };
    map.on("movestart", stopFollowing);
    return () => {
      map.off("movestart", stopFollowing);
    };
  }, [map, onFollowChange]);

  useEffect(() => {
    if (!current && !inspected) return;
    markerRef.current?.setLngLat([longitude, latitude]);
    if (current) {
      liveMarkerRef.current?.setLngLat([current.longitude, current.latitude]);
    }
    if (map && inspected) {
      map.jumpTo({ center: [longitude, latitude] });
    } else if (map && follow) {
      map.jumpTo({ center: [longitude, latitude] });
    }
  }, [current, follow, inspected, latitude, longitude, map]);

  return (
    <div className="satellite-map-stage" aria-label="Interactive satellite ground track map">
      <Map
        center={[longitude, latitude]}
        zoom={3.2}
        theme={theme}
        projection={{ type: "mercator" }}
        renderWorldCopies
        minZoom={1.2}
        maxZoom={14}
        onReady={handleReady}
      />
      <div className="map-controls" aria-label="Map controls">
        <button
          type="button"
          onClick={() => {
            onFollowChange(false);
            map?.zoomIn();
          }}
          aria-label="Zoom in"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={() => {
            onFollowChange(false);
            map?.zoomOut();
          }}
          aria-label="Zoom out"
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          className={follow && !inspected ? "is-active" : undefined}
          disabled={!current}
          onClick={() => {
            if (!current) return;
            onReturnToLive();
            map?.easeTo({
              center: [current.longitude, current.latitude],
              duration: 600,
            });
          }}
          aria-label={inspected ? "Return to live satellite position" : "Return to satellite"}
        >
          <Scan size={15} />
        </button>
      </div>
    </div>
  );
}
