export type SourceLink = {
  label: string;
  url: string;
};

export type OrbitalElements = {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
};

export type SatelliteRecord = {
  noradId: number;
  satnogsId: string;
  cosparId: string;
  name: string;
  alternateName: string;
  operator: string | null;
  operatorDescription: string | null;
  manufacturer: string | null;
  country: string | null;
  launchDate: string | null;
  status: "operational" | "inactive" | "unknown";
  function: string | null;
  dataCenterRelation: string | null;
  inclinationDeg: number;
  periodMinutes: number;
  orbitalElements: OrbitalElements | null;
  tleLine1: string | null;
  tleLine2: string | null;
  sources: SourceLink[];
  missionEnrichedAt: string | null;
  operatorEnrichedAt: string | null;
  updatedAt: string;
};
