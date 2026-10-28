import type { MerchantMcc } from '../merchants/mcc';
import { CountryApplication, MerchantApiErrorCode, MerchantLifecycleStatus, RegionalMidView } from '../merchants/merchant-models';
import type { MerchantRecord } from './merchant-server';

// Merchant identity rules for the simulated backend.
//
//   GMID (GM-…)      the merchant record, shared by a parent and its sub-merchants
//   GA-…             the separate login account (auth data), linked from the merchant record
//   ME-…             internal merchant entity: one parent per GMID, sub-merchants under it; never shown
//   APP-…            a country application
//   KS-…             a key-set reference (not an MID)
//   MID-…            a live regional MID: at most one per entity per region, globally unique,
//                    issued only at a successful go-live. Opaque: region and country are stored
//                    on the record and never read from the MID string.

export interface LegalEntityDetails {
  legalName: string;
  registrationNumber: string;
}

export interface MerchantEntity {
  id: string;
  gmid: string;
  kind: 'parent' | 'sub';
  /** Null for the parent; required and fixed for a sub-merchant. */
  parentEntityId: string | null;
  /** Null when the entity trades under the parent's legal identity (and always for the parent, whose profile is the GMID record). */
  legalEntity: LegalEntityDetails | null;
  displayName?: string;
  /** Sub-merchants only; the parent's lifecycle stays on the merchant record. */
  lifecycleStatus?: MerchantLifecycleStatus;
  lifecycleReason?: string | null;
  createdAt: number;
  createdBy: string;
}

export interface RegionalMid {
  mid: string;
  entityId: string;
  gmid: string;
  regionCode: string;
  country: string;
  environment: 'live';
  source: 'go_live' | 'migrated';
  issuedAt: number;
  issuedBy: string;
  applicationId: string | null;
  goLiveEvidenceAt?: number;
  demo: boolean;
}

/** A go-live that has started but not yet been saved as complete. Removed when it completes. */
export interface GoLiveIntent {
  applicationId: string;
  startedAt: number;
  by: string;
}

export interface IdentityRuleError {
  code: MerchantApiErrorCode;
  message: string;
}

export const MID_PATTERN = /^MID-\d{9}$/;

export const formatMid = (n: number) => `MID-${String(n).padStart(9, '0')}`;
export const formatEntityId = (n: number) => `ME-${String(n).padStart(6, '0')}`;

/** Highest number used in a list of IDs such as ME-000004 or MID-000000012 (0 if none). */
export function maxSequence(ids: string[]): number {
  return ids.reduce((max, id) => Math.max(max, Number(id.replace(/\D/g, '')) || 0), 0);
}

export function parentEntityOf(entities: MerchantEntity[], gmid: string): MerchantEntity | undefined {
  return entities.find((e) => e.gmid === gmid && e.kind === 'parent');
}

/** The entity an application belongs to; older applications without `entityId` belong to the parent. */
export function entityOfApplication(entities: MerchantEntity[], app: Pick<CountryApplication, 'merchantId' | 'entityId'>): MerchantEntity | undefined {
  return app.entityId ? entities.find((e) => e.id === app.entityId) : parentEntityOf(entities, app.merchantId);
}

/** Structural problems with an entity: one parent per GMID, exactly one parent per sub, no deeper nesting. */
export function entityProblems(entity: MerchantEntity, entities: MerchantEntity[]): string[] {
  const out: string[] = [];
  if (entity.kind === 'parent') {
    if (entity.parentEntityId !== null) out.push('A parent entity cannot have a parent.');
    if (entities.filter((e) => e.gmid === entity.gmid && e.kind === 'parent').length > 1) out.push(`${entity.gmid} has more than one parent entity.`);
  } else {
    const parent = entity.parentEntityId ? entities.find((e) => e.id === entity.parentEntityId) : undefined;
    if (!entity.parentEntityId) out.push('A sub-merchant must have exactly one parent.');
    else if (!parent) out.push(`Parent ${entity.parentEntityId} does not exist.`);
    else if (parent.kind !== 'parent') out.push('A sub-merchant cannot be the parent of another sub-merchant.');
    else if (parent.gmid !== entity.gmid) out.push("A sub-merchant must share its parent's GMID.");
  }
  // The MCC belongs to the parent merchant (GMID record); no entity carries its own.
  if ('mcc' in entity) out.push(entity.kind === 'sub' ? "A sub-merchant uses its parent's MCC and cannot have its own." : 'The MCC is kept on the merchant record, not the entity.');
  if (entity.legalEntity) {
    if (!entity.legalEntity.legalName.trim()) out.push('A separate legal entity needs a legal name.');
    if (!entity.legalEntity.registrationNumber.trim()) out.push('A separate legal entity needs a registration number.');
  }
  return out;
}

/** A parent's or sub-merchant's MCC: always the parent merchant's (GMID record). */
export function mccOfEntity(merchants: Pick<MerchantRecord, 'id' | 'mcc'>[], entities: MerchantEntity[], entityId: string): MerchantMcc | null {
  const entity = entities.find((e) => e.id === entityId);
  return (entity && merchants.find((m) => m.id === entity.gmid)?.mcc) ?? null;
}

/** Re-parenting is out of scope: a saved sub-merchant keeps its parent. */
export function parentChangeProblem(before: MerchantEntity, after: MerchantEntity): string | null {
  return before.parentEntityId !== after.parentEntityId ? "A sub-merchant's parent cannot be changed." : null;
}

export interface GoLiveContext {
  merchants: MerchantRecord[];
  entities: MerchantEntity[];
  applications: CountryApplication[];
}

/**
 * Why an entity cannot go live in a country, or null if it can. The parent is never blocked by
 * its children. A sub-merchant needs its parent operational in the same country, and neither
 * may be suspended (a parent's suspension doesn't suspend the child, but does block its go-live).
 */
export function goLiveBlocker(ctx: GoLiveContext, entityId: string, country: string): IdentityRuleError | null {
  const entity = ctx.entities.find((e) => e.id === entityId);
  if (!entity) return { code: 'NOT_FOUND', message: 'The merchant entity for this go-live does not exist.' };
  const merchant = ctx.merchants.find((m) => m.id === entity.gmid);
  if (!merchant) return { code: 'NOT_FOUND', message: `No Global Merchant ${entity.gmid}.` };
  if (merchant.lifecycleStatus === 'suspended') {
    return { code: 'MERCHANT_SUSPENDED', message: `${merchant.legalName} is suspended, so it can't go live. Risk must reactivate the merchant first.` };
  }
  if (entity.kind === 'sub') {
    const name = entity.displayName ?? entity.legalEntity?.legalName ?? 'This sub-merchant';
    if (entity.lifecycleStatus === 'suspended') return { code: 'MERCHANT_SUSPENDED', message: `${name} is suspended, so it can't go live.` };
    const parent = ctx.entities.find((e) => e.id === entity.parentEntityId);
    const parentLive = !!parent && ctx.applications.some((a) => a.country === country && a.status === 'operational' && entityOfApplication(ctx.entities, a)?.id === parent.id);
    if (!parentLive) return { code: 'PARENT_NOT_OPERATIONAL', message: `${name} can't go live until ${merchant.legalName} is operational in this country.` };
  }
  return null;
}

export interface MidStore {
  mids?: RegionalMid[];
  seq: { mid?: number };
}

export type NewMid = Omit<RegionalMid, 'mid' | 'environment'>;

/**
 * Issues the next live MID. Refuses a second MID for the same entity and region. The value is
 * taken from one global sequence; if the sequence points at a value already in use (for example
 * edited data), it moves forward to the next free value, so values stay unique.
 */
export function issueMid(store: MidStore, input: NewMid): RegionalMid | IdentityRuleError {
  store.mids ??= [];
  const held = store.mids.find((m) => m.entityId === input.entityId && m.regionCode === input.regionCode);
  if (held) return { code: 'MID_CONFLICT', message: `This entity already has live MID ${held.mid} in this region.` };
  const used = new Set(store.mids.map((m) => m.mid));
  let n = Math.max(store.seq.mid ?? 1, 1);
  while (used.has(formatMid(n))) n++;
  const mid: RegionalMid = { ...input, mid: formatMid(n), environment: 'live' };
  store.seq.mid = n + 1;
  store.mids.push(mid);
  return mid;
}

export const isRuleError = (v: unknown): v is IdentityRuleError => !!v && typeof v === 'object' && 'code' in v && 'message' in v && !('mid' in v);

/** Duplicate values or more than one MID per entity and region (reported, never auto-fixed). */
export function midProblems(mids: RegionalMid[], entities: MerchantEntity[]): { mid: string; problem: string }[] {
  const out: { mid: string; problem: string }[] = [];
  const seen = new Map<string, number>();
  const pairs = new Map<string, string>();
  for (const m of mids) {
    seen.set(m.mid, (seen.get(m.mid) ?? 0) + 1);
    const key = `${m.entityId}|${m.regionCode}`;
    if (pairs.has(key)) out.push({ mid: m.mid, problem: `Second MID for the same entity and region (first: ${pairs.get(key)}).` });
    else pairs.set(key, m.mid);
    if (!entities.some((e) => e.id === m.entityId)) out.push({ mid: m.mid, problem: 'Issued to an entity that does not exist.' });
  }
  for (const [mid, count] of seen) if (count > 1) out.push({ mid, problem: `MID value used ${count} times.` });
  return out;
}

export function toMidView(m: RegionalMid): RegionalMidView {
  return { mid: m.mid, regionCode: m.regionCode, country: m.country, environment: m.environment, source: m.source, issuedAt: m.issuedAt, goLiveEvidenceAt: m.goLiveEvidenceAt ?? null, applicationId: m.applicationId };
}
