import type { SatelliteRecord } from "./types";

export const starcloudFallback: SatelliteRecord = {
  noradId: 66303,
  satnogsId: "MEKC-1774-6115-5644-8771",
  cosparId: "2025-248L",
  name: "STARCLOUD-1",
  alternateName: "LUMEN-1",
  operator: "Starcloud",
  operatorDescription: "Operator summary pending Gemini enrichment.",
  manufacturer: "Astro Digital (satellite platform)",
  country: "United States",
  launchDate: "2025-11-02T05:09:00Z",
  status: "operational",
  function: "Mission summary pending Gemini enrichment.",
  dataCenterRelation: "Orbital compute demonstrator",
  inclinationDeg: 45.3997,
  periodMinutes: 94.63,
  orbitalElements: null,
  tleLine1:
    "1 66303U 25248L   26207.16029198  .00005005  00000+0  22976-3 0  9990",
  tleLine2:
    "2 66303  45.3997 271.0639 0006321 268.1150  91.9012 15.21652070 40476",
  sources: [
    {
      label: "CelesTrak",
      url: "https://celestrak.org/NORAD/elements/gp.php?CATNR=66303&FORMAT=JSON",
    },
    {
      label: "SatNOGS DB",
      url: "https://db.satnogs.org/satellite/MEKC-1774-6115-5644-8771/",
    },
    {
      label: "Starcloud",
      url: "https://www.starcloud.com/starcloud-1",
    },
  ],
  missionEnrichedAt: null,
  operatorEnrichedAt: null,
  updatedAt: "2026-07-26T03:50:49.227072Z",
};
