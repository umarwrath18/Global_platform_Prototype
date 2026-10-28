import { COUNTRY_CATALOGUE } from '../mock-server/seed';

// Regions for live MIDs. Initially each onboarding country is its own region (MY -> Malaysia).
// This mapping is a configuration decision, not something to derive from an identifier: every
// application and MID stores its region when created, so a later change here never moves an
// existing record. Unmapped countries get no region (and therefore no MID) until one is added.

export interface Region {
  code: string;
  name: string;
  countries: string[];
}

export const REGIONS: Region[] = ['MY', 'ID', 'VN', 'TH', 'PH'].map((code) => ({ code, name: COUNTRY_CATALOGUE[code].name, countries: [code] }));

export function regionForCountry(country: string): string | null {
  return REGIONS.find((r) => r.countries.includes(country))?.code ?? null;
}

export function regionName(code: string): string {
  return REGIONS.find((r) => r.code === code)?.name ?? code;
}
