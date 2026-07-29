"use client";

import { Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import Link from "next/link";
import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  twoline2satrec,
} from "satellite.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { MathUtils, Vector3 } from "three";
import type { Group, Mesh } from "three";
import type { SatelliteRecord } from "@/lib/types";

type OrbitalPoint = {
  latitude: number;
  longitude: number;
  altitude: number;
};

type EnrichmentState = {
  status: "idle" | "loading" | "completed" | "needs_review" | "error";
  message?: string;
};

type EnrichedSatellite = Pick<
  SatelliteRecord,
  | "noradId"
  | "function"
  | "operatorDescription"
  | "sources"
  | "missionEnrichedAt"
  | "operatorEnrichedAt"
>;

const EARTH_RADIUS_KM = 6378.137;
const POSITION_UPDATE_INTERVAL_MS = 1_000;
const INITIAL_ORBITAL_POINT: OrbitalPoint = {
  latitude: 0,
  longitude: 0,
  altitude: 0,
};

function dampAngle(
  current: number,
  target: number,
  smoothing: number,
  delta: number,
) {
  const difference = Math.atan2(
    Math.sin(target - current),
    Math.cos(target - current),
  );
  return current + difference * (1 - Math.exp(-smoothing * delta));
}

function getOrbitalPoint(
  satellite: SatelliteRecord,
  date = new Date(),
): OrbitalPoint {
  try {
    const satrec = satellite.orbitalElements
      ? json2satrec(satellite.orbitalElements)
      : satellite.tleLine1 && satellite.tleLine2
        ? twoline2satrec(satellite.tleLine1, satellite.tleLine2)
        : null;
    if (!satrec) {
      throw new Error("Orbital elements unavailable");
    }
    const result = propagate(satrec, date);

    if (!result?.position || typeof result.position === "boolean") {
      throw new Error("Position unavailable");
    }

    const geodetic = eciToGeodetic(result.position, gstime(date));
    return {
      latitude: (geodetic.latitude * 180) / Math.PI,
      longitude: (geodetic.longitude * 180) / Math.PI,
      altitude: geodetic.height,
    };
  } catch {
    return { latitude: 0, longitude: 0, altitude: 0 };
  }
}

function Earth({ orbitalPoint }: { orbitalPoint: OrbitalPoint }) {
  const grid = useRef<Mesh>(null);
  const targetLongitude = -MathUtils.degToRad(orbitalPoint.longitude);
  const targetLatitude = MathUtils.degToRad(orbitalPoint.latitude) * 0.22;

  useFrame((_, delta) => {
    if (!grid.current) return;
    grid.current.rotation.y = dampAngle(
      grid.current.rotation.y,
      targetLongitude,
      1.8,
      delta,
    );
    grid.current.rotation.x = MathUtils.damp(
      grid.current.rotation.x,
      0.08 + targetLatitude,
      1.8,
      delta,
    );
  });

  return (
    <group position={[0, -4.75, 0]}>
      <mesh>
        <sphereGeometry args={[4.45, 96, 96]} />
        <meshStandardMaterial
          color="#071f39"
          emissive="#03162a"
          emissiveIntensity={0.55}
          metalness={0.1}
          roughness={0.86}
        />
      </mesh>

      <mesh ref={grid} rotation={[0.08, targetLongitude, 0]}>
        <sphereGeometry args={[4.47, 48, 48]} />
        <meshBasicMaterial
          color="#2c8bc0"
          wireframe
          transparent
          opacity={0.085}
        />
      </mesh>

      <mesh>
        <sphereGeometry args={[4.58, 96, 96]} />
        <meshBasicMaterial
          color="#4cbaf2"
          transparent
          opacity={0.08}
          side={1}
        />
      </mesh>

      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.44, 0]}>
        <ringGeometry args={[0.08, 0.14, 48]} />
        <meshBasicMaterial color="#73ddff" transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

function SatelliteMarker({
  selected,
  onSelect,
  orbitalPoint,
}: {
  selected: boolean;
  onSelect: () => void;
  orbitalPoint: OrbitalPoint;
}) {
  const group = useRef<Group>(null);
  const marker = useRef<Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const targetPosition = useMemo(() => {
    const longitudeProgress = orbitalPoint.longitude / 180;
    const latitudeProgress = orbitalPoint.latitude / 90;
    const altitudeOffset = MathUtils.clamp(
      orbitalPoint.altitude / EARTH_RADIUS_KM,
      0,
      0.18,
    );

    return new Vector3(
      longitudeProgress * 3.8,
      0.92 + latitudeProgress * 1.35 + altitudeOffset,
      0,
    );
  }, [orbitalPoint]);

  useFrame(({ clock }, delta) => {
    if (group.current) {
      if (Math.abs(group.current.position.x - targetPosition.x) > 6) {
        group.current.position.x = targetPosition.x;
      }
      group.current.position.lerp(
        targetPosition,
        1 - Math.exp(-4.5 * delta),
      );
    }

    if (marker.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 3.2) * 0.12;
      marker.current.scale.setScalar(pulse);
    }
  });

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "default";
    return () => {
      document.body.style.cursor = "default";
    };
  }, [hovered]);

  return (
    <group ref={group} position={targetPosition}>
      <mesh
        ref={marker}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <sphereGeometry args={[selected ? 0.1 : 0.075, 32, 32]} />
        <meshBasicMaterial color="#d7f7ff" />
      </mesh>
      <pointLight color="#55cfff" intensity={selected ? 7 : 4} distance={4} />
      <mesh>
        <ringGeometry args={[0.19, 0.205, 64]} />
        <meshBasicMaterial
          color="#67d8ff"
          transparent
          opacity={selected ? 0.75 : 0.34}
        />
      </mesh>
    </group>
  );
}

function OrbitalScene({
  selected,
  onSelect,
  orbitalPoint,
}: {
  selected: boolean;
  onSelect: () => void;
  orbitalPoint: OrbitalPoint;
}) {
  return (
    <>
      <color attach="background" args={["#02050a"]} />
      <fog attach="fog" args={["#02050a", 11, 26]} />
      <ambientLight intensity={0.35} color="#6ba9c9" />
      <directionalLight
        position={[-6, 8, 10]}
        intensity={2.4}
        color="#bceaff"
      />
      <Stars
        radius={70}
        depth={38}
        count={1600}
        factor={1.9}
        saturation={0.1}
        fade
        speed={0.25}
      />
      <Earth orbitalPoint={orbitalPoint} />
      <SatelliteMarker
        selected={selected}
        onSelect={onSelect}
        orbitalPoint={orbitalPoint}
      />
    </>
  );
}

function Coordinate({ value, axis }: { value: number; axis: "lat" | "lon" }) {
  const direction =
    axis === "lat"
      ? value >= 0
        ? "N"
        : "S"
      : value >= 0
        ? "E"
        : "W";
  return (
    <>
      {Math.abs(value).toFixed(2)}° {direction}
    </>
  );
}

function isAiResearchSource(label: string) {
  const normalized = label.toLowerCase();
  return (
    normalized.includes("mission research") ||
    normalized.includes("operator research")
  );
}

function sourceHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Research source";
  }
}

export function SpaceExplorer({
  satellites,
  dataMode,
}: {
  satellites: SatelliteRecord[];
  dataMode: "live" | "demo";
}) {
  const [catalog, setCatalog] = useState(satellites);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selected, setSelected] = useState(true);
  const [enrichmentStates, setEnrichmentStates] = useState<
    Record<number, EnrichmentState>
  >({});
  const [orbitalPoint, setOrbitalPoint] = useState<OrbitalPoint>(
    INITIAL_ORBITAL_POINT,
  );
  const satellite = catalog[selectedIndex] ?? catalog[0];

  useEffect(() => {
    setCatalog(satellites);
  }, [satellites]);

  useEffect(() => {
    const update = () => setOrbitalPoint(getOrbitalPoint(satellite));
    update();
    const interval = window.setInterval(
      update,
      POSITION_UPDATE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [satellite]);

  const launchYear = useMemo(
    () =>
      satellite.launchDate
        ? new Date(satellite.launchDate).getUTCFullYear()
        : null,
    [satellite.launchDate],
  );
  const catalogPosition = `${String(selectedIndex + 1).padStart(
    String(catalog.length).length,
    "0",
  )} / ${catalog.length}`;
  const selectSatellite = (index: number) => {
    setSelectedIndex(index);
    setSelected(true);
  };
  const selectPrevious = () =>
    selectSatellite(
      (selectedIndex - 1 + catalog.length) % catalog.length,
    );
  const selectNext = () =>
    selectSatellite((selectedIndex + 1) % catalog.length);
  const hasEditorialDetails =
    satellite.function || satellite.operatorDescription;
  const displaySources = useMemo(() => {
    const catalogHosts = new Set(
      satellite.sources
        .filter((source) => !isAiResearchSource(source.label))
        .map((source) => sourceHostname(source.url)),
    );
    const shownResearchHosts = new Set<string>();

    return satellite.sources.flatMap((source) => {
      if (!isAiResearchSource(source.label)) return [source];

      const hostname = sourceHostname(source.url);
      if (
        catalogHosts.has(hostname) ||
        shownResearchHosts.has(hostname)
      ) {
        return [];
      }

      shownResearchHosts.add(hostname);
      return [{ ...source, label: hostname }];
    });
  }, [satellite.sources]);
  const enrichmentState = enrichmentStates[satellite.noradId] ?? {
    status: "idle",
  };
  const isFullyEnriched = Boolean(
    satellite.missionEnrichedAt && satellite.operatorEnrichedAt,
  );

  const applyEnrichment = (enriched: EnrichedSatellite) => {
    setCatalog((current) =>
      current.map((item) =>
        item.noradId === enriched.noradId
          ? { ...item, ...enriched }
          : item,
      ),
    );
  };

  const enhanceSatellite = async () => {
    const noradId = satellite.noradId;
    setEnrichmentStates((current) => ({
      ...current,
      [noradId]: { status: "loading" },
    }));

    try {
      const response = await fetch(`/api/satellites/${noradId}/enrich`, {
        method: "POST",
      });
      const queued = (await response.json()) as {
        status?: string;
        runId?: string;
        satellite?: EnrichedSatellite;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(queued.error ?? "Unable to start AI enrichment.");
      }

      if (queued.status === "already_enriched" && queued.satellite) {
        applyEnrichment(queued.satellite);
        setEnrichmentStates((current) => ({
          ...current,
          [noradId]: { status: "completed" },
        }));
        return;
      }

      if (!queued.runId) {
        throw new Error("The enrichment run was not created.");
      }

      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
        const statusResponse = await fetch(
          `/api/satellites/${noradId}/enrich?runId=${encodeURIComponent(queued.runId)}`,
          { cache: "no-store" },
        );
        const result = (await statusResponse.json()) as {
          status?: string;
          satellite?: EnrichedSatellite;
          error?: string;
        };

        if (!statusResponse.ok) {
          throw new Error(result.error ?? "AI enrichment did not complete.");
        }
        if (result.status === "running") continue;

        if (
          (result.status === "completed" ||
            result.status === "needs_review") &&
          result.satellite
        ) {
          const completedStatus = result.status;
          applyEnrichment(result.satellite);
          setEnrichmentStates((current) => ({
            ...current,
            [noradId]: {
              status: completedStatus,
              message:
                completedStatus === "needs_review"
                  ? "AI could not verify every field with enough evidence."
                  : undefined,
            },
          }));
          return;
        }

        throw new Error(result.error ?? "AI enrichment did not complete.");
      }

      throw new Error(
        "AI enrichment is taking longer than expected. Try again later.",
      );
    } catch (error) {
      setEnrichmentStates((current) => ({
        ...current,
        [noradId]: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "AI enrichment is temporarily unavailable.",
        },
      }));
    }
  };

  return (
    <main className="explorer-shell">
      <Canvas
        className="space-canvas"
        camera={{ position: [0, 0.1, 11.6], fov: 48 }}
        dpr={[1, 1.65]}
        gl={{ antialias: true }}
        onPointerMissed={() => setSelected(false)}
      >
        <OrbitalScene
          selected={selected}
          onSelect={() => setSelected(true)}
          orbitalPoint={orbitalPoint}
        />
      </Canvas>

      <header className="site-header">
        <Link className="brand" href="/" aria-label="OpenSpace home">
          <span className="brand-mark" />
          <span>OPENSPACE</span>
        </Link>
        <div className="data-state">
          <span className={dataMode === "live" ? "live-dot" : "demo-dot"} />
          {dataMode === "live" ? "LIVE SOURCES" : "DEMO DATA"}
        </div>
      </header>

      <section className="scene-intro" aria-label="Current satellite">
        <p>ORBITAL OBJECT {catalogPosition}</p>
        <h1>{satellite.name}</h1>
        <span>Click the light to explore</span>
      </section>

      {selected && (
        <aside className="satellite-card" aria-label="Satellite information">
          <button
            className="close-button"
            type="button"
            onClick={() => setSelected(false)}
            aria-label="Close satellite information"
          >
            ×
          </button>

          <div className="card-eyebrow">
            <span className="status-dot" />
            {satellite.status}
          </div>
          <h2>{satellite.name}</h2>
          {satellite.alternateName && (
            <p className="alternate-name">{satellite.alternateName}</p>
          )}

          <dl className="facts-grid">
            {satellite.operator && (
              <div>
                <dt>Operator</dt>
                <dd>{satellite.operator}</dd>
              </div>
            )}
            {satellite.manufacturer && (
              <div>
                <dt>Manufacturer</dt>
                <dd>{satellite.manufacturer}</dd>
              </div>
            )}
            {launchYear && (
              <div>
                <dt>Launch year</dt>
                <dd>{launchYear}</dd>
              </div>
            )}
            {satellite.country && (
              <div>
                <dt>Country</dt>
                <dd>{satellite.country}</dd>
              </div>
            )}
            <div>
              <dt>NORAD ID</dt>
              <dd>{satellite.noradId}</dd>
            </div>
            <div>
              <dt>Inclination</dt>
              <dd>{satellite.inclinationDeg.toFixed(2)}°</dd>
            </div>
            <div>
              <dt>Orbital period</dt>
              <dd>{satellite.periodMinutes.toFixed(1)} min</dd>
            </div>
          </dl>

          {satellite.function && (
            <div className="function-block">
              <span>Mission function</span>
              <p>{satellite.function}</p>
            </div>
          )}

          {satellite.operatorDescription && (
            <div className="operator-block">
              <span>About the operator</span>
              <p>{satellite.operatorDescription}</p>
            </div>
          )}

          {!hasEditorialDetails && (
            <p className="catalog-note">
              Mission details are not available in the current public bulk
              sources. Orbital data below is verified against CelesTrak.
            </p>
          )}

          {dataMode === "live" && (
            <div className="enrichment-action" aria-live="polite">
              {isFullyEnriched ? (
                <span className="enrichment-complete">✓ Enhanced with AI</span>
              ) : (
                <button
                  type="button"
                  onClick={enhanceSatellite}
                  disabled={enrichmentState.status === "loading"}
                  className={
                    enrichmentState.status === "loading"
                      ? "is-loading"
                      : undefined
                  }
                >
                  {enrichmentState.status === "loading" ? (
                    <span className="enrichment-loading-label">
                      <span className="enrichment-orbit" aria-hidden>
                        <i />
                      </span>
                      <span>Enhancing</span>
                      <span className="enrichment-loading-dots" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                    </span>
                  ) : (
                    "Enhance with AI"
                  )}
                </button>
              )}
              {enrichmentState.message && (
                <p className="enrichment-message">
                  {enrichmentState.message}
                </p>
              )}
            </div>
          )}

          <div className="orbit-strip">
            <div>
              <span>Latitude</span>
              <strong>
                <Coordinate value={orbitalPoint.latitude} axis="lat" />
              </strong>
            </div>
            <div>
              <span>Longitude</span>
              <strong>
                <Coordinate value={orbitalPoint.longitude} axis="lon" />
              </strong>
            </div>
          </div>

          <footer className="card-footer">
            <span>Sources</span>
            <div>
              {displaySources.map((source) => (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${source.label}-${source.url}`}
                  title={`Source: ${source.url}`}
                >
                  {source.label}
                </a>
              ))}
            </div>
          </footer>
        </aside>
      )}

      <nav className="satellite-navigation" aria-label="Satellite navigation">
        <button
          type="button"
          onClick={selectPrevious}
          aria-label="Previous satellite"
        >
          ←
        </button>
        <select
          aria-label="Select a satellite"
          value={selectedIndex}
          onChange={(event) => selectSatellite(Number(event.target.value))}
        >
          {catalog.map((catalogSatellite, index) => (
            <option value={index} key={catalogSatellite.noradId}>
              {catalogSatellite.name} · {catalogSatellite.noradId}
            </option>
          ))}
        </select>
        <button type="button" onClick={selectNext} aria-label="Next satellite">
          →
        </button>
      </nav>

      <div className="position-readout" aria-hidden="true">
        <span>LIVE PROPAGATION · 1S</span>
        <strong>
          <Coordinate value={orbitalPoint.latitude} axis="lat" />
          {"  ·  "}
          <Coordinate value={orbitalPoint.longitude} axis="lon" />
        </strong>
      </div>
    </main>
  );
}
