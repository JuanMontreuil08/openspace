"use client";

import Link from "next/link";
import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  twoline2satrec,
} from "satellite.js";
import { useEffect, useMemo, useState } from "react";
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

const POSITION_UPDATE_INTERVAL_MS = 1_000;
const INITIAL_ORBITAL_POINT: OrbitalPoint = {
  latitude: 0,
  longitude: 0,
  altitude: 0,
};

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

  const mapMarkers = useMemo(() => {
    const indices = Array.from(
      new Set([selectedIndex, 0, 1, 2, 3, 4]),
    ).filter((index) => index < catalog.length);

    return indices.map((index) => {
      const point = getOrbitalPoint(catalog[index]);
      return {
        index,
        satellite: catalog[index],
        left: `${18 + ((point.longitude + 180) / 360) * 64}%`,
        top: `${18 + ((90 - point.latitude) / 180) * 64}%`,
      };
    });
  }, [catalog, selectedIndex]);

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
      <div className="minimal-earth" aria-label="Satellite world map">
        <div className="minimal-earth-grid" aria-hidden="true" />
        {mapMarkers.map((marker) => (
          <button
            className={`map-marker${
              selected && marker.index === selectedIndex ? " is-selected" : ""
            }`}
            key={marker.satellite.noradId}
            type="button"
            style={{ left: marker.left, top: marker.top }}
            onClick={() => selectSatellite(marker.index)}
            aria-label={`Select ${marker.satellite.name}`}
          >
            <span />
          </button>
        ))}
      </div>

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
