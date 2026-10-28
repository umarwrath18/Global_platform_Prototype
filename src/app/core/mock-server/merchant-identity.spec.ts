import { describe, expect, it } from 'vitest';
import { CountryApplication } from '../merchants/merchant-models';
import { entityProblems, goLiveBlocker, isRuleError, issueMid, MerchantEntity, MID_PATTERN, midProblems, MidStore, NewMid, parentChangeProblem, RegionalMid, toMidView } from './merchant-identity';
import type { MerchantRecord } from './merchant-server';

const parent: MerchantEntity = { id: 'ME-000001', gmid: 'GM-1', kind: 'parent', parentEntityId: null, legalEntity: null, createdAt: 0, createdBy: 'x' };
const child = (over: Partial<MerchantEntity> = {}): MerchantEntity => ({ id: 'ME-000002', gmid: 'GM-1', kind: 'sub', parentEntityId: 'ME-000001', legalEntity: null, displayName: 'Kiosk 1', lifecycleStatus: 'active', createdAt: 0, createdBy: 'x', ...over });
const merchant = (over: Partial<MerchantRecord> = {}): MerchantRecord =>
  ({ id: 'GM-1', legalName: 'Parent Sdn Bhd', registrationCountry: 'MY', registrationNumber: '1', primaryContact: { name: '', email: '', phone: '' }, linkedAccountId: null, createdAt: 0, updatedAt: 0, createdBy: 'x', demo: false, lifecycleStatus: 'active', ...over }) as MerchantRecord;
const app = (over: Partial<CountryApplication>): CountryApplication => ({ id: 'APP-1', merchantId: 'GM-1', country: 'MY', status: 'operational', history: [] }) as unknown as CountryApplication & typeof over;
const mid = (over: Partial<NewMid> = {}): NewMid => ({ entityId: 'ME-000001', gmid: 'GM-1', regionCode: 'MY', country: 'MY', source: 'go_live', issuedAt: 1, issuedBy: 'CS', applicationId: 'APP-1', demo: false, ...over });

describe('merchant identity rules', () => {
  describe('parent and child entities', () => {
    it('accepts a parent and a child with or without a separate legal entity', () => {
      expect(entityProblems(parent, [parent])).toEqual([]);
      expect(entityProblems(child(), [parent, child()])).toEqual([]);
      const separate = child({ legalEntity: { legalName: 'Kiosk Sdn Bhd', registrationNumber: '202401000001' } });
      expect(entityProblems(separate, [parent, separate])).toEqual([]);
    });

    it('requires exactly one parent of the same GMID, with no deeper nesting', () => {
      expect(entityProblems(child({ parentEntityId: null }), [parent])).toContain('A sub-merchant must have exactly one parent.');
      expect(entityProblems(child({ parentEntityId: 'ME-999999' }), [parent])).toContain('Parent ME-999999 does not exist.');
      const grandchild = child({ id: 'ME-000003', parentEntityId: 'ME-000002' });
      expect(entityProblems(grandchild, [parent, child(), grandchild])).toContain('A sub-merchant cannot be the parent of another sub-merchant.');
      const other = child({ gmid: 'GM-2' });
      expect(entityProblems(other, [parent, other])).toContain("A sub-merchant must share its parent's GMID.");
      expect(entityProblems({ ...parent, parentEntityId: 'ME-000009' }, [parent])).toContain('A parent entity cannot have a parent.');
      const second = { ...parent, id: 'ME-000009' };
      expect(entityProblems(parent, [parent, second])).toContain('GM-1 has more than one parent entity.');
    });

    it('requires both legal name and registration number for a separate legal entity', () => {
      const partial = child({ legalEntity: { legalName: 'Kiosk Sdn Bhd', registrationNumber: ' ' } });
      expect(entityProblems(partial, [parent, partial])).toEqual(['A separate legal entity needs a registration number.']);
    });

    it('does not allow re-parenting', () => {
      expect(parentChangeProblem(child(), child({ parentEntityId: 'ME-000005' }))).toBe("A sub-merchant's parent cannot be changed.");
      expect(parentChangeProblem(child(), child({ displayName: 'Renamed' }))).toBeNull();
    });
  });

  describe('go-live gate', () => {
    const ctx = (opts: { parentLiveIn?: string[]; parentSuspended?: boolean; childSuspended?: boolean } = {}) => ({
      merchants: [merchant({ lifecycleStatus: opts.parentSuspended ? 'suspended' : 'active' })],
      entities: [parent, child({ lifecycleStatus: opts.childSuspended ? 'suspended' : 'active' })],
      applications: (opts.parentLiveIn ?? []).map((country, i) => ({ ...app({}), id: `APP-${i}`, country, entityId: 'ME-000001' })) as CountryApplication[],
    });

    it('lets an unsuspended parent go live regardless of its children', () => {
      expect(goLiveBlocker(ctx({ childSuspended: true }), 'ME-000001', 'MY')).toBeNull();
      expect(goLiveBlocker(ctx({ parentSuspended: true }), 'ME-000001', 'MY')?.code).toBe('MERCHANT_SUSPENDED');
    });

    it('blocks a child until its parent is operational in the same country', () => {
      expect(goLiveBlocker(ctx(), 'ME-000002', 'MY')?.code).toBe('PARENT_NOT_OPERATIONAL');
      expect(goLiveBlocker(ctx({ parentLiveIn: ['TH'] }), 'ME-000002', 'MY')?.code).toBe('PARENT_NOT_OPERATIONAL');
      expect(goLiveBlocker(ctx({ parentLiveIn: ['MY'] }), 'ME-000002', 'MY')).toBeNull();
    });

    it('blocks a child while either the parent or the child is suspended, without suspending the child', () => {
      const c = ctx({ parentLiveIn: ['MY'], parentSuspended: true });
      expect(goLiveBlocker(c, 'ME-000002', 'MY')?.code).toBe('MERCHANT_SUSPENDED');
      expect(c.entities[1].lifecycleStatus).toBe('active');
      expect(goLiveBlocker(ctx({ parentLiveIn: ['MY'], childSuspended: true }), 'ME-000002', 'MY')?.code).toBe('MERCHANT_SUSPENDED');
    });
  });

  describe('live MIDs', () => {
    it('issues one opaque MID per entity per region, unique across regions and entities', () => {
      const store: MidStore = { seq: {} };
      const first = issueMid(store, mid()) as RegionalMid;
      expect(first.mid).toBe('MID-000000001');
      expect(first.mid).toMatch(MID_PATTERN);
      expect(issueMid(store, mid({ applicationId: 'APP-2' }))).toMatchObject({ code: 'MID_CONFLICT' });
      const otherRegion = issueMid(store, mid({ regionCode: 'TH', country: 'TH' })) as RegionalMid;
      const childSameRegion = issueMid(store, mid({ entityId: 'ME-000002' })) as RegionalMid;
      expect([otherRegion.mid, childSameRegion.mid]).toEqual(['MID-000000002', 'MID-000000003']);
      expect(new Set(store.mids!.map((m) => m.mid)).size).toBe(3);
      expect(midProblems(store.mids!, [parent, child()])).toEqual([]);
    });

    it('never reuses a value, even if the sequence was set back', () => {
      const store: MidStore = { seq: {} };
      issueMid(store, mid());
      issueMid(store, mid({ entityId: 'ME-000002' }));
      store.seq.mid = 1; // e.g. edited data
      const next = issueMid(store, mid({ regionCode: 'TH', country: 'TH' }));
      expect(isRuleError(next)).toBe(false);
      expect((next as RegionalMid).mid).toBe('MID-000000003');
      expect(new Set(store.mids!.map((m) => m.mid)).size).toBe(3);
    });

    it('reads region and country from the record, not the MID string, and hides the internal entity', () => {
      const store: MidStore = { seq: { mid: 42 } };
      const issued = issueMid(store, mid({ regionCode: 'PH', country: 'PH' })) as RegionalMid;
      expect(issued.mid).toBe('MID-000000042');
      const view = toMidView(issued);
      expect(view).toMatchObject({ mid: 'MID-000000042', regionCode: 'PH', country: 'PH', environment: 'live' });
      expect(JSON.stringify(view)).not.toContain('ME-');
    });

    it('reports duplicate values and second MIDs per entity and region', () => {
      const a = { ...mid(), mid: 'MID-000000001', environment: 'live' as const };
      const problems = midProblems([a, { ...a }, { ...a, mid: 'MID-000000002' }], [parent]);
      expect(problems.map((p) => p.problem)).toEqual(expect.arrayContaining([expect.stringMatching(/used 2 times/), expect.stringMatching(/Second MID/)]));
    });
  });
});
