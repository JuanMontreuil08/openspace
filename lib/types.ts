export type SourceLink = {
  label: string;
  url: string;
};

export type SatelliteRecord = {
  noradId: number;
  satnogsId: string;
  cosparId: string;
  name: string;
  alternateName: string;
  operator: string;
  operatorDescription: string;
  manufacturer: string;
  country: string;
  launchDate: string;
  status: "operational" | "inactive" | "unknown";
  function: string;
  dataCenterRelation: string;
  inclinationDeg: number;
  periodMinutes: number;
  tleLine1: string;
  tleLine2: string;
  sources: SourceLink[];
  updatedAt: string;
};
