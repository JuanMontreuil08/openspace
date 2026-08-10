"use client";

import Link from "next/link";
import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  twoline2satrec,
  type SatRec,
} from "satellite.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SatelliteMap } from "@/components/SatelliteMap";
import { TextRoll } from "@/components/core/text-roll";
import { SITE_NAME, THEME_STORAGE_KEY } from "@/lib/brand";
import {
  findGroundTrackSample,
  formatGroundTrackOffset,
  type GroundTrackPoint,
  type GroundTrackSample,
} from "@/lib/ground-track";
import { enrichmentPrompt } from "@/lib/enrichment-copy";
import { getOrbitFreshness } from "@/lib/orbit-freshness";
import { searchSatelliteCatalog } from "@/lib/satellite-search";
import type { SatelliteIndexEntry, SatelliteRecord } from "@/lib/types";

type OrbitalPoint = {
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  heading: number;
};

type OrbitTrack = {
  past: GroundTrackSample[];
  predicted: GroundTrackSample[];
  calculatedAt: Date;
};

type EnrichmentState = {
  status: "idle" | "loading" | "completed" | "needs_review" | "error";
  message?: string;
};

type EnrichedSatellite = Pick<
  SatelliteRecord,
  | "noradId"
  | "missionDescription"
  | "operator"
  | "operatorDescription"
  | "sources"
  | "missionEnrichedAt"
  | "operatorEnrichedAt"
>;

const POSITION_UPDATE_INTERVAL_MS = 1_000;
const TRACK_UPDATE_INTERVAL_MS = 30_000;
const TRACK_SAMPLE_INTERVAL_MS = 30_000;
const PAST_TRACK_MINUTES = 20;
const PREDICTED_TRACK_MINUTES = 40;
const INITIAL_ORBIT_TRACK: OrbitTrack = {
  past: [],
  predicted: [],
  calculatedAt: new Date(0),
};

function getSatelliteRecord(satellite: SatelliteRecord): SatRec | null {
  if (satellite.orbitalElements) {
    return json2satrec(satellite.orbitalElements);
  }
  if (satellite.tleLine1 && satellite.tleLine2) {
    return twoline2satrec(satellite.tleLine1, satellite.tleLine2);
  }
  return null;
}

function propagateOrbitalPoint(satrec: SatRec, date: Date) {
  const result = propagate(satrec, date);
  if (!result?.position || typeof result.position === "boolean") return null;

  const geodetic = eciToGeodetic(result.position, gstime(date));
  const velocity =
    result.velocity && typeof result.velocity !== "boolean"
      ? Math.hypot(result.velocity.x, result.velocity.y, result.velocity.z)
      : 0;
  return {
    latitude: (geodetic.latitude * 180) / Math.PI,
    longitude: (geodetic.longitude * 180) / Math.PI,
    altitude: geodetic.height,
    velocity,
  };
}

function calculateBearing(from: GroundTrackPoint, to: GroundTrackPoint) {
  const latitude1 = (from.latitude * Math.PI) / 180;
  const latitude2 = (to.latitude * Math.PI) / 180;
  const longitudeDelta = ((to.longitude - from.longitude) * Math.PI) / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function getOrbitalPoint(
  satellite: SatelliteRecord,
  date = new Date(),
): OrbitalPoint | null {
  try {
    const satrec = getSatelliteRecord(satellite);
    if (!satrec) {
      throw new Error("Orbital elements unavailable");
    }
    const current = propagateOrbitalPoint(satrec, date);
    const next = propagateOrbitalPoint(
      satrec,
      new Date(date.getTime() + 10_000),
    );
    if (!current || !next) {
      throw new Error("Position unavailable");
    }
    return {
      ...current,
      heading: calculateBearing(current, next),
    };
  } catch {
    return null;
  }
}

function getOrbitTrack(
  satellite: SatelliteRecord,
  calculatedAt = new Date(),
): OrbitTrack {
  try {
    const satrec = getSatelliteRecord(satellite);
    if (!satrec) return { ...INITIAL_ORBIT_TRACK, calculatedAt };

    const past: GroundTrackSample[] = [];
    const predicted: GroundTrackSample[] = [];
    const start = -PAST_TRACK_MINUTES * 60_000;
    const end = PREDICTED_TRACK_MINUTES * 60_000;
    for (let offset = start; offset <= end; offset += TRACK_SAMPLE_INTERVAL_MS) {
      const point = propagateOrbitalPoint(
        satrec,
        new Date(calculatedAt.getTime() + offset),
      );
      if (!point) continue;
      const trackPoint = {
        latitude: point.latitude,
        longitude: point.longitude,
        offsetMinutes: offset / 60_000,
      };
      if (offset <= 0) past.push(trackPoint);
      if (offset >= 0) predicted.push(trackPoint);
    }
    return { past, predicted, calculatedAt };
  } catch {
    return { ...INITIAL_ORBIT_TRACK, calculatedAt };
  }
}

function headingLabel(heading: number) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${Math.round(heading)}° ${directions[Math.round(heading / 45) % 8]}`;
}

function formatUtcEpoch(epoch: Date) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(epoch);
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

function isSafeExternalUrl(url: string) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/* ── Theme hook ── */

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("light");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as
      | "dark"
      | "light"
      | null;
    const initialTheme = stored === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", initialTheme);
    const timer = window.setTimeout(() => setTheme(initialTheme), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

/* ── Command Palette ── */

function CommandPalette({
  catalog,
  selectedIndex,
  onSelect,
  onClose,
}: {
  catalog: SatelliteIndexEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const search = useMemo(
    () => searchSatelliteCatalog(catalog, selectedIndex, query),
    [catalog, query, selectedIndex],
  );
  const filtered = search.results;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[highlightedIndex]) {
      onSelect(filtered[highlightedIndex].index);
      onClose();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="palette-input-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search by name, NORAD ID, operator, or country…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightedIndex(0);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-empty">
              No satellites match &ldquo;{query}&rdquo;
            </div>
          )}
          {filtered.map(({ satellite, index }, i) => (
            <button
              key={satellite.noradId}
              type="button"
              className={`palette-item${i === highlightedIndex ? " is-highlighted" : ""}${index === selectedIndex ? " is-current" : ""}`}
              onClick={() => {
                onSelect(index);
                onClose();
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              <div className="palette-item-main">
                <span className="palette-item-name">{satellite.name}</span>
                <span className="palette-item-meta">
                  {satellite.operator && <span>{satellite.operator}</span>}
                  {satellite.country && <span>{satellite.country}</span>}
                </span>
              </div>
              <span className="palette-item-norad">{satellite.noradId}</span>
            </button>
          ))}
        </div>
        <div className="palette-footer">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span>
            {query.trim()
              ? `${filtered.length} of ${search.totalMatches} matches`
              : `Current satellite · ${catalog.length} total`}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Main Explorer ── */

export function SpaceExplorer({
  catalog: initialCatalog,
  initialSatellite,
  dataMode,
}: {
  catalog: SatelliteIndexEntry[];
  initialSatellite: SatelliteRecord;
  dataMode: "live" | "demo";
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const [catalog, setCatalog] = useState(initialCatalog);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const index = initialCatalog.findIndex(
      (entry) => entry.noradId === initialSatellite.noradId,
    );
    return index >= 0 ? index : 0;
  });
  const [satellite, setSatellite] = useState(initialSatellite);
  const detailCache = useRef(new Map([[initialSatellite.noradId, initialSatellite]]));
  const selectionRequest = useRef(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [followSatellite, setFollowSatellite] = useState(true);
  const [inspectedOffsetMinutes, setInspectedOffsetMinutes] = useState<number | null>(null);
  const [enrichmentStates, setEnrichmentStates] = useState<
    Record<number, EnrichmentState>
  >({});
  const [orbitalPoint, setOrbitalPoint] = useState<OrbitalPoint | null>(null);
  const [orbitTrack, setOrbitTrack] = useState<OrbitTrack>(
    INITIAL_ORBIT_TRACK,
  );
  const inspectedPoint = useMemo(() => {
    if (inspectedOffsetMinutes === null) return null;
    return findGroundTrackSample(
      [...orbitTrack.past, ...orbitTrack.predicted],
      inspectedOffsetMinutes,
    );
  }, [inspectedOffsetMinutes, orbitTrack.past, orbitTrack.predicted]);
  const inspectionLabel = inspectedPoint
    ? formatGroundTrackOffset(inspectedPoint.offsetMinutes)
    : null;
  const inspectedAt = inspectedPoint
    ? new Date(
        orbitTrack.calculatedAt.getTime() + inspectedPoint.offsetMinutes * 60_000,
      )
    : null;

  const returnToLive = useCallback(() => {
    setInspectedOffsetMinutes(null);
    setFollowSatellite(true);
  }, []);

  useEffect(() => {
    const update = () => setOrbitalPoint(getOrbitalPoint(satellite));
    update();
    const interval = window.setInterval(update, POSITION_UPDATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [satellite]);

  useEffect(() => {
    const update = () => setOrbitTrack(getOrbitTrack(satellite));
    update();
    const interval = window.setInterval(update, TRACK_UPDATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [satellite]);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (e.key === "Escape" && panelOpen) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [panelOpen]);

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
  const orbitFreshness = useMemo(() => {
    const value = satellite.orbitalElements?.EPOCH ?? satellite.updatedAt;
    return getOrbitFreshness(value);
  }, [satellite.orbitalElements?.EPOCH, satellite.updatedAt]);
  const {
    epoch: orbitEpoch,
    ageLabel: orbitAge,
    isStale: isOrbitStale,
  } = orbitFreshness;

  const selectSatellite = useCallback(async (index: number) => {
    const entry = catalog[index];
    if (!entry) return;
    setPanelOpen(true);
    setFollowSatellite(true);
    setInspectedOffsetMinutes(null);
    const requestId = selectionRequest.current + 1;
    selectionRequest.current = requestId;

    try {
      let detail = detailCache.current.get(entry.noradId);
      if (!detail) {
        const response = await fetch(`/api/satellites/${entry.noradId}`, {
          cache: "no-store",
        });
        const result = (await response.json()) as {
          satellite?: SatelliteRecord;
          error?: string;
        };
        if (!response.ok || !result.satellite) {
          throw new Error(result.error ?? "Satellite details are unavailable.");
        }
        detail = result.satellite;
        detailCache.current.set(entry.noradId, detail);
      }

      if (selectionRequest.current !== requestId) return;
      setSatellite(detail);
      setSelectedIndex(index);
    } catch (error) {
      if (selectionRequest.current !== requestId) return;
      setEnrichmentStates((current) => ({
        ...current,
        [entry.noradId]: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Satellite details are temporarily unavailable.",
        },
      }));
    }
  }, [catalog]);

  const selectPrevious = () =>
    selectSatellite(
      (selectedIndex - 1 + catalog.length) % catalog.length,
    );
  const selectNext = () =>
    selectSatellite((selectedIndex + 1) % catalog.length);
  const displaySources = useMemo(() => {
    const catalogHosts = new Set(
      satellite.sources
        .filter((source) => isSafeExternalUrl(source.url))
        .filter((source) => !isAiResearchSource(source.label))
        .map((source) => sourceHostname(source.url)),
    );
    const shownResearchHosts = new Set<string>();

    return satellite.sources.flatMap((source) => {
      if (!isSafeExternalUrl(source.url)) return [];
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
  const missingEnrichmentPrompt = enrichmentPrompt({
    hasMissionDescription: Boolean(satellite.missionDescription),
    hasOperatorName: Boolean(satellite.operator),
    hasOperatorDescription: Boolean(satellite.operatorDescription),
  });

  const applyEnrichment = (enriched: EnrichedSatellite) => {
    setSatellite((current) => {
      if (current.noradId !== enriched.noradId) return current;
      const updated = { ...current, ...enriched };
      detailCache.current.set(updated.noradId, updated);
      return updated;
    });
    setCatalog((current) => current.map((item) =>
      item.noradId === enriched.noradId
        ? { ...item, operator: enriched.operator }
        : item,
    ));
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
    <main className={`explorer-shell${panelOpen ? " has-detail-panel" : ""}`}>
      <SatelliteMap
        current={orbitalPoint}
        past={orbitTrack.past}
        predicted={orbitTrack.predicted}
        inspected={inspectedPoint}
        inspectionLabel={inspectionLabel}
        satelliteName={satellite.name}
        theme={theme}
        follow={followSatellite}
        onFollowChange={setFollowSatellite}
        onReturnToLive={returnToLive}
      />

      {/* Header */}
      <header className="site-header">
        <Link className="brand" href="/" aria-label={`${SITE_NAME} home`}>
          <span className="brand-mark" />
          <TextRoll
            className="brand-wordmark"
            variants={{
              enter: {
                initial: { y: 0 },
                animate: { y: 40 },
              },
              exit: {
                initial: { y: -40 },
                animate: { y: 0 },
              },
            }}
            duration={0.3}
            getEnterDelay={(index) => index * 0.05}
            getExitDelay={(index) => index * 0.05 + 0.05}
            transition={{ ease: [0.175, 0.885, 0.32, 1.1] }}
          >
            {SITE_NAME}
          </TextRoll>
        </Link>
        <div className="header-actions">
          <button
            type="button"
            className="search-trigger"
            onClick={() => setPaletteOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <span className="search-trigger-label">Search satellites</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <div className="data-state">
            <span className={dataMode === "live" ? "live-dot" : "demo-dot"} />
            {dataMode === "live" ? "LIVE" : "DEMO"}
          </div>
        </div>
      </header>

      {/* Satellite info overlay on the left */}
      <section className="scene-intro" aria-label="Current satellite">
        <p>ORBITAL OBJECT {catalogPosition}</p>
        <h1>{satellite.name}</h1>
        <p className="scene-subtitle">
          {satellite.operator && <span>{satellite.operator}</span>}
          {satellite.country && <span>{satellite.country}</span>}
        </p>
        {orbitalPoint ? (
          <div className="live-coords">
            <Coordinate value={orbitalPoint.latitude} axis="lat" />
            <span className="coord-sep" />
            <Coordinate value={orbitalPoint.longitude} axis="lon" />
            <span className="coord-sep" />
            <span>{orbitalPoint.altitude.toFixed(0)} km</span>
          </div>
        ) : (
          <p className="live-coords">Current position unavailable</p>
        )}
        {!panelOpen && (
          <button
            type="button"
            className="explore-cta"
            onClick={() => setPanelOpen(true)}
          >
            View details
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </button>
        )}
      </section>

      {!panelOpen && (
        <aside className="map-position-card" aria-label="Satellite position summary">
          <p className="position-card-kicker">Satellite information</p>
          <p className="position-card-satellite-name">{satellite.name}</p>
          <p className="position-card-context">Currently overflying</p>
          <h2>
            {orbitalPoint ? (
              <>
                <Coordinate value={orbitalPoint.latitude} axis="lat" /> ·{" "}
                <Coordinate value={orbitalPoint.longitude} axis="lon" />
              </>
            ) : (
              "Position unavailable"
            )}
          </h2>
          <p className="position-card-subtitle">
            Follow the marker to inspect the cities, terrain, and borders below.
          </p>
          <dl className="position-stats">
            <div>
              <dt>Altitude</dt>
              <dd>{orbitalPoint ? `${orbitalPoint.altitude.toFixed(1)} km` : "—"}</dd>
            </div>
            <div>
              <dt>Velocity</dt>
              <dd>{orbitalPoint ? `${orbitalPoint.velocity.toFixed(2)} km/s` : "—"}</dd>
            </div>
            <div>
              <dt>Heading</dt>
              <dd>{orbitalPoint ? headingLabel(orbitalPoint.heading) : "—"}</dd>
            </div>
            <div>
              <dt>NORAD ID</dt>
              <dd>{satellite.noradId}</dd>
            </div>
          </dl>
          <button
            type="button"
            className="follow-satellite-button"
            aria-pressed={followSatellite}
            onClick={() => {
              if (inspectedPoint || !followSatellite) returnToLive();
              else setFollowSatellite(false);
            }}
          >
            <span>Follow satellite</span>
            <span>{followSatellite ? "ON" : "OFF"}</span>
          </button>
          <button
            type="button"
            className="open-profile-button"
            onClick={() => setPanelOpen(true)}
          >
            Open complete satellite profile
          </button>
        </aside>
      )}

      <section className="ground-track-panel" aria-label="Satellite ground track timeline">
        <div className="ground-track-header">
          <div className="ground-track-legend">
            <span><i className="past-line" />Past</span>
            <span><i className="predicted-line" />Predicted</span>
            {inspectedPoint && (
              <button type="button" onClick={returnToLive}>
                Return to live
              </button>
            )}
          </div>
          {inspectedPoint && inspectedAt ? (
            <div className="ground-track-selection" aria-live="polite">
              <output htmlFor="ground-track-scrubber">
                {inspectionLabel} · {inspectedAt.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </output>
            </div>
          ) : (
            <span className="ground-track-live"><i />Live position</span>
          )}
        </div>
        <div className="ground-track-scrubber">
          <div className="ground-track-bar" aria-hidden="true">
            <span className="ground-track-past-segment" />
            <span className="ground-track-future-segment" />
          </div>
          <input
            id="ground-track-scrubber"
            type="range"
            min={-PAST_TRACK_MINUTES}
            max={PREDICTED_TRACK_MINUTES}
            step={0.5}
            value={inspectedOffsetMinutes ?? 0}
            aria-label="Inspect satellite position from 20 minutes ago to 40 minutes ahead"
            aria-valuetext={formatGroundTrackOffset(inspectedOffsetMinutes ?? 0)}
            onChange={(event) => {
              setInspectedOffsetMinutes(Number(event.target.value));
              setFollowSatellite(false);
            }}
          />
        </div>
        <div className="ground-track-ticks">
          <span style={{ left: "0%" }}>−20m</span>
          <span style={{ left: "16.667%" }}>−10m</span>
          <span className="is-now" style={{ left: "33.333%" }}>Now</span>
          <span style={{ left: "50%" }}>+10m</span>
          <span style={{ left: "66.667%" }}>+20m</span>
          <span style={{ left: "100%" }}>+40m</span>
        </div>
        <div
          className={`orbit-freshness${isOrbitStale ? " is-stale" : ""}`}
          role="note"
          aria-label="Orbital data freshness"
        >
          <span className="orbit-freshness-icon" aria-hidden />
          <div className="orbit-freshness-copy">
            <strong>Predicted position</strong>
            <span>
              {orbitAge ? `Orbital data ${orbitAge}` : "Orbital epoch unavailable"}
              {isOrbitStale ? " — accuracy may be reduced" : ""}
            </span>
          </div>
          <div className="orbit-freshness-meta">
            {orbitEpoch && (
              <time dateTime={orbitEpoch.toISOString()}>
                Epoch {formatUtcEpoch(orbitEpoch)}
              </time>
            )}
            <span>
              CelesTrak {satellite.orbitalElements ? "OMM" : "TLE"} · SGP4
            </span>
          </div>
        </div>
      </section>

      {/* Slide-out detail panel */}
      <aside
        className={`detail-panel${panelOpen ? " is-open" : ""}`}
        aria-label="Satellite information"
      >
        <div className="panel-header">
          <div>
            <div className="card-eyebrow">
              <span className="status-dot" />
              {satellite.status}
            </div>
            <h2>{satellite.name}</h2>
            {satellite.alternateName && (
              <p className="alternate-name">{satellite.alternateName}</p>
            )}
          </div>
          <button
            className="close-button"
            type="button"
            onClick={() => setPanelOpen(false)}
            aria-label="Close panel"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="panel-body">
          {/* Live position strip */}
          <div className="orbit-strip">
            <div>
              <span>Latitude</span>
              <strong>
                {orbitalPoint ? <Coordinate value={orbitalPoint.latitude} axis="lat" /> : "—"}
              </strong>
            </div>
            <div>
              <span>Longitude</span>
              <strong>
                {orbitalPoint ? <Coordinate value={orbitalPoint.longitude} axis="lon" /> : "—"}
              </strong>
            </div>
            <div>
              <span>Altitude</span>
              <strong>{orbitalPoint ? `${orbitalPoint.altitude.toFixed(1)} km` : "—"}</strong>
            </div>
          </div>

          {/* Facts */}
          <div className="panel-section">
            <h3 className="section-label">Orbital data</h3>
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
          </div>

          {satellite.missionDescription && (
            <div className="panel-section">
              <h3 className="section-label">Mission description</h3>
              <p className="section-body">{satellite.missionDescription}</p>
            </div>
          )}

          {satellite.operatorDescription && (
            <div className="panel-section">
              <h3 className="section-label">About the operator</h3>
              <p className="section-body">{satellite.operatorDescription}</p>
            </div>
          )}

          {!isFullyEnriched && (
            <p className="catalog-note">{missingEnrichmentPrompt}</p>
          )}

          {dataMode === "live" && (
            <div className="enrichment-action" aria-live="polite">
              {isFullyEnriched ? (
                <span className="enrichment-complete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Enhanced with AI
                </span>
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
                <p className="enrichment-message">{enrichmentState.message}</p>
              )}
            </div>
          )}

          <div className="panel-section sources-section">
            <h3 className="section-label">Sources</h3>
            <div className="sources-list">
              {displaySources.map((source) => (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${source.label}-${source.url}`}
                  title={`Source: ${source.url}`}
                >
                  {source.label}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Bottom navigation */}
      <nav className="satellite-navigation" aria-label="Satellite navigation">
        <button type="button" onClick={selectPrevious} aria-label="Previous satellite">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          className="nav-search-button"
          onClick={() => setPaletteOpen(true)}
        >
          <span>{satellite.name}</span>
          <kbd>⌘K</kbd>
        </button>
        <button type="button" onClick={selectNext} aria-label="Next satellite">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </nav>

      {/* Command palette */}
      {paletteOpen && (
        <CommandPalette
          catalog={catalog}
          selectedIndex={selectedIndex}
          onSelect={selectSatellite}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </main>
  );
}
