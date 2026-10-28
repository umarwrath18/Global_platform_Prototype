import { regionForCountry } from '../merchants/regions';
import { entityOfApplication, entityProblems, formatEntityId, isRuleError, issueMid, maxSequence, midProblems, parentEntityOf } from './merchant-identity';
import type { MerchantDb } from './merchant-server';

// Upgrades stored merchant data to schema revision 3 (entities, regions, live MIDs).
//
// - Additive only: `version` stays 2 so older builds still load the data, and no existing field,
//   history entry, notification or lifecycle event is changed.
// - Deterministic and idempotent: running it again changes nothing. It runs on every load, so
//   records written by an older build (without entityId/regionCode/MID) are filled in later.
// - Never invents evidence: an operational application gets an MID only when its history records
//   the go-live; the MID is dated when it was assigned, with the go-live time kept separately.
//   Anything that can't be upgraded safely is reported as a flag and left as it is.

export const SCHEMA_REVISION = 3;
export const UPGRADE_ACTOR = 'System (data upgrade)';

export type MigrationFlagReason = 'ORPHAN_APPLICATION' | 'NO_REGION' | 'GO_LIVE_RECORD_MISSING' | 'SECOND_OPERATIONAL_IN_REGION' | 'ENTITY_INVALID' | 'MID_INVALID' | 'GO_LIVE_INCOMPLETE';

export interface MigrationFlag {
  reason: MigrationFlagReason;
  recordId: string;
  detail: string;
}

export interface MigrationLogEntry {
  at: number;
  revision: number;
  entitiesAdded: number;
  applicationsUpdated: number;
  midsAssigned: number;
}

export interface NormaliseResult {
  db: MerchantDb;
  changed: boolean;
  entry: MigrationLogEntry | null;
}

export function normaliseMerchantDb(stored: MerchantDb, now: number): NormaliseResult {
  const db = structuredClone(stored) as MerchantDb;
  let entitiesAdded = 0;
  let applicationsUpdated = 0;
  let midsAssigned = 0;
  let changed = false;

  if (!db.entities) {
    db.entities = [];
    changed = true;
  }
  if (!db.mids) {
    db.mids = [];
    changed = true;
  }
  if (db.seq.entity === undefined) {
    db.seq.entity = maxSequence(db.entities.map((e) => e.id)) + 1;
    changed = true;
  }
  if (db.seq.mid === undefined) {
    db.seq.mid = maxSequence(db.mids.map((m) => m.mid)) + 1;
    changed = true;
  }

  // 1. One parent entity per merchant, in creation order so IDs are the same on every run.
  for (const m of [...db.merchants].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (parentEntityOf(db.entities, m.id)) continue;
    db.entities.push({ id: formatEntityId(db.seq.entity++), gmid: m.id, kind: 'parent', parentEntityId: null, legalEntity: null, createdAt: m.createdAt, createdBy: m.createdBy });
    entitiesAdded++;
  }

  // 2. Entity and region on applications (only where missing; a stored region is never changed).
  for (const app of db.applications) {
    let touched = false;
    if (!app.entityId) {
      const entity = parentEntityOf(db.entities, app.merchantId);
      if (entity) {
        app.entityId = entity.id;
        touched = true;
      }
    }
    if (!app.regionCode) {
      const region = regionForCountry(app.country);
      if (region) {
        app.regionCode = region;
        touched = true;
      }
    }
    if (touched) applicationsUpdated++;
  }

  // 3. Live MIDs for operational applications that have recorded go-live evidence.
  const operational = db.applications
    .filter((a) => a.status === 'operational' && !db.mids!.some((m) => m.applicationId === a.id))
    .map((a) => ({ a, evidence: [...a.history].reverse().find((h) => h.toStatus === 'operational') }))
    .sort((x, y) => (x.evidence?.at ?? Infinity) - (y.evidence?.at ?? Infinity) || x.a.id.localeCompare(y.a.id));
  for (const { a, evidence } of operational) {
    const entity = entityOfApplication(db.entities, a);
    if (!evidence || !entity || !a.regionCode) continue; // reported by migrationFlags()
    if (db.mids.some((m) => m.entityId === entity.id && m.regionCode === a.regionCode)) continue; // reported
    const issued = issueMid(db, {
      entityId: entity.id,
      gmid: entity.gmid,
      regionCode: a.regionCode,
      country: a.country,
      source: 'migrated',
      issuedAt: now,
      issuedBy: UPGRADE_ACTOR,
      applicationId: a.id,
      goLiveEvidenceAt: evidence.at,
      demo: a.demo,
    });
    if (!isRuleError(issued)) midsAssigned++;
  }

  changed ||= entitiesAdded > 0 || applicationsUpdated > 0 || midsAssigned > 0;
  let entry: MigrationLogEntry | null = null;
  if ((db.schemaRevision ?? 2) < SCHEMA_REVISION) {
    db.schemaRevision = SCHEMA_REVISION;
    changed = true;
  }
  if (changed) {
    entry = { at: now, revision: SCHEMA_REVISION, entitiesAdded, applicationsUpdated, midsAssigned };
    db.migrationLog = [...(db.migrationLog ?? []), entry].slice(-50);
  }
  return { db, changed, entry };
}

/** Records that could not be upgraded safely, or that break an identity rule. Computed, never auto-fixed. */
export function migrationFlags(db: MerchantDb): MigrationFlag[] {
  const flags: MigrationFlag[] = [];
  const entities = db.entities ?? [];
  const mids = db.mids ?? [];
  const regionUse = new Map<string, string>();
  for (const a of [...db.applications].sort((x, y) => x.createdAt - y.createdAt)) {
    const entity = entityOfApplication(entities, a);
    if (!db.merchants.some((m) => m.id === a.merchantId)) flags.push({ reason: 'ORPHAN_APPLICATION', recordId: a.id, detail: `Merchant ${a.merchantId} does not exist.` });
    if (!a.regionCode && !regionForCountry(a.country)) flags.push({ reason: 'NO_REGION', recordId: a.id, detail: `No region is configured for ${a.country}, so no MID can be issued.` });
    if (a.status !== 'operational') continue;
    if (!a.history.some((h) => h.toStatus === 'operational')) {
      flags.push({ reason: 'GO_LIVE_RECORD_MISSING', recordId: a.id, detail: 'Operational, but the history has no go-live event. No MID was assigned.' });
    }
    const key = `${entity?.id}|${a.regionCode}`;
    if (entity && a.regionCode && regionUse.has(key)) {
      flags.push({ reason: 'SECOND_OPERATIONAL_IN_REGION', recordId: a.id, detail: `${regionUse.get(key)} is already operational for this entity and region. No second MID was assigned.` });
    } else if (entity && a.regionCode) regionUse.set(key, a.id);
  }
  for (const e of entities) for (const p of entityProblems(e, entities)) flags.push({ reason: 'ENTITY_INVALID', recordId: e.id, detail: p });
  for (const p of midProblems(mids, entities)) flags.push({ reason: 'MID_INVALID', recordId: p.mid, detail: p.problem });
  for (const i of db.goLiveIntents ?? []) flags.push({ reason: 'GO_LIVE_INCOMPLETE', recordId: i.applicationId, detail: `Go-live started ${new Date(i.startedAt).toISOString()} by ${i.by} and has not completed. Retrying go-live finishes it safely.` });
  return flags;
}
