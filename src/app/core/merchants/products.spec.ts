import { describe, expect, it } from 'vitest';
import {
  activateVersion,
  calculateFee,
  resolvePricing,
  classifyPeriod,
  gapCount,
  mdrWarnings,
  money,
  nextSubscriptionCharge,
  PricingDraft,
  pricingSummary,
  PricingVersion,
  productGaps,
  promoMdr,
  roundFee,
  runStatusJob,
  validateDates,
  validatePrimary,
  validateSecondary,
  validateTiers,
  vaBanksIntersect,
} from './products';

const draft = (over: Partial<PricingDraft> = {}): PricingDraft => ({
  flow: 'payin',
  methodCode: 'fpx',
  vaBanks: [],
  technique: 'variable_rate',
  currency: 'MYR',
  mdrPct: 1.5,
  fixedFee: null,
  minimumFee: 0,
  volumePeriod: null,
  tiers: null,
  historical: null,
  subscription: null,
  promotion: null,
  startDate: '2026-11-10',
  endDate: null,
  ...over,
});

let seq = 0;
const version = (over: Partial<PricingVersion> = {}): PricingVersion => ({
  ...draft(),
  id: `PV-${++seq}`,
  applicationId: 'APP-1',
  version: 1,
  status: 'active',
  usd: null,
  source: 'onboarding',
  settlementSnapshot: null,
  editOf: null,
  createdBy: 'x',
  createdById: 'u',
  createdRole: 'cs',
  createdAt: 0,
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  cancelledBy: null,
  cancelledAt: null,
  ...over,
});

const fee = (v: Partial<PricingVersion>, amount: number, extra: object = {}, cur = 'MYR') => calculateFee({ ...version(v), localCurrency: cur }, { amount, ...extra });

describe('fee engine (§5.2)', () => {
  it('Percentage, with the minimum fee as a floor', () => {
    expect(fee({ mdrPct: 1.5 }, 100_000).fee).toBe(1500);
    expect(fee({ mdrPct: 1.5, minimumFee: 2 }, 100).fee).toBe(2);
    expect(fee({ mdrPct: 1.5, minimumFee: 2 }, 1000).fee).toBe(15);
  });

  it('Fixed Fee in local currency and in USD at the static rate', () => {
    expect(fee({ technique: 'fixed_fee', fixedFee: 1.25, mdrPct: null }, 500).fee).toBe(1.25);
    const usd = fee({ technique: 'fixed_fee', currency: 'USD', fixedFee: 0.5, mdrPct: null, usd: { fixedFeeUsd: 0.5, usdExchangeRate: 16000, localEquivalent: 8000, localEquivalentCurrency: 'IDR' } }, 100_000, {}, 'IDR');
    expect(usd.fee).toBe(8000);
    expect(usd.breakdown.map((r) => r[0])).toEqual(['Fixed Fee (USD)', 'Exchange Rate', 'IDR Equivalent', 'Transaction Amount', 'Fee']);
  });

  it('Percentage + Fixed and Higher of (with the winner)', () => {
    expect(fee({ technique: 'variable_plus_fixed', mdrPct: 1, fixedFee: 0.5 }, 100).fee).toBe(1.5);
    const low = fee({ technique: 'higher_of', mdrPct: 1, minimumFee: 5 }, 100);
    expect([low.fee, low.breakdown.find((r) => r[0] === 'Winner')?.[1]]).toEqual([5, 'minimum']);
    const high = fee({ technique: 'higher_of', mdrPct: 1, minimumFee: 5 }, 10_000);
    expect([high.fee, high.breakdown.find((r) => r[0] === 'Winner')?.[1]]).toEqual([100, 'percentage']);
  });

  it('Volume-Based: one tier for the whole transaction, min inclusive and max exclusive', () => {
    const tiers = [
      { minVolume: 0, maxVolume: 1_000_000, mdrPct: 1.5, fixedFee: 0 },
      { minVolume: 1_000_000, maxVolume: 5_000_000, mdrPct: 1.2, fixedFee: 0.1 },
      { minVolume: 5_000_000, maxVolume: null, mdrPct: 1.0, fixedFee: 0 },
    ];
    const v = { technique: 'volume_based' as const, mdrPct: null, tiers };
    expect(fee(v, 100, { periodVolume: 999_999 }).fee).toBe(1.5);
    expect(fee(v, 100, { periodVolume: 1_000_000 }).fee).toBe(1.3);
    expect(fee(v, 100, { periodVolume: 5_000_000 }).fee).toBe(1);
    expect(fee({ ...v, tiers: [tiers[1]] }, 100, { periodVolume: 10 })).toMatchObject({ fee: 0, warning: 'No matching tier found for the given volume.' });
  });

  it('Historical Volume in both directions, and the default MDR with no history', () => {
    const h = { referencePeriod: 'previous_month' as const, evaluationMetric: 'gmv' as const, volumeThreshold: 10_000_000, thresholdDirection: '>=' as const, resultingMdr: 1, resultingFixedFee: 0 as const, defaultMdr: 2, defaultFixedFee: 0 as const, targetPeriod: 'current_month' as const };
    const v = { technique: 'historical_volume' as const, mdrPct: null, historical: h };
    expect(fee(v, 100, { previousPeriodVolume: 10_000_000 }).fee).toBe(1);
    expect(fee(v, 100, { previousPeriodVolume: 9_999_999 }).fee).toBe(2);
    expect(fee({ ...v, historical: { ...h, thresholdDirection: '<' } }, 100, { previousPeriodVolume: 9_999_999 }).fee).toBe(1);
    expect(fee(v, 100, { previousPeriodVolume: null })).toMatchObject({ fee: 2, explanation: 'No previous-period data, so the default MDR applies.' });
  });

  it('rounds half up to the minor unit, with IDR and VND in whole units', () => {
    expect(roundFee(1.005, 'MYR')).toBe(1.01);
    expect(roundFee(1500.5, 'IDR')).toBe(1501);
    expect(roundFee(1500.4, 'VND')).toBe(1500);
    expect(money(1500, 'IDR')).toBe('IDR 1.500');
    expect(money(1500, 'MYR')).toBe('MYR 1,500.00');
  });

  it('subscription only charges no per-transaction fee', () => {
    expect(fee({ technique: null, mdrPct: null, subscription: { monthlyFee: 100, currency: 'MYR' } }, 1000).fee).toBe(0);
  });
});

describe('secondary charges', () => {
  it('unconditional promotion replaces the primary pricing during its dates only', () => {
    const p = { type: 'unconditional' as const, mdrPct: 0.5, startDate: '2026-11-01', endDate: '2026-11-30' };
    expect(promoMdr(p, '2026-11-15', 0)).toBe(0.5);
    expect(promoMdr(p, '2026-12-01', 0)).toBeNull();
    expect(fee({ mdrPct: 1.5, promotion: p }, 1000, { date: '2026-11-15' }).fee).toBe(5);
  });

  it('conditional promotion: after the condition is met, the highest matching threshold wins', () => {
    const p = { type: 'conditional' as const, mdrPct: 1, startDate: '2026-11-01', endDate: null, conditions: [{ op: '>=' as const, value: 1000, mdrPct: 1.2 }, { op: '>' as const, value: 5000, mdrPct: 0.8 }] };
    expect(promoMdr(p, '2026-11-02', 999)).toBeNull();
    expect(promoMdr(p, '2026-11-02', 1000)).toBe(1.2);
    expect(promoMdr(p, '2026-11-02', 5000)).toBe(1.2);
    expect(promoMdr(p, '2026-11-02', 5001)).toBe(0.8);
  });

  it('subscription is charged on the 1st for the previous month', () => {
    expect(nextSubscriptionCharge({ subscription: { monthlyFee: 100, currency: 'MYR' }, startDate: '2026-10-05', endDate: null }, '2026-11-10')).toMatchObject({ date: '2026-12-01', forMonth: 'Nov 2026', amount: 100 });
    expect(nextSubscriptionCharge({ subscription: { monthlyFee: 100, currency: 'MYR' }, startDate: '2026-12-05', endDate: null }, '2026-11-10')).toBeNull();
  });

  it('validates the secondary charges and subscription-only pricing', () => {
    expect(validateSecondary(draft({ subscription: { monthlyFee: -1, currency: 'MYR' } })).map((i) => i.message)).toEqual(['Subscription fee cannot be negative']);
    expect(validateSecondary(draft({ technique: null })).map((i) => i.message)).toEqual(['If the Primary Pricing Method is not configured, Subscription Fees must be configured.']);
    expect(validateSecondary(draft({ promotion: { type: 'unconditional', mdrPct: -1, startDate: '2026-11-10', endDate: null } })).map((i) => i.message)).toEqual(['Promotional MDR cannot be negative']);
  });
});

describe('validation (§4.2, §7.4, §7.5)', () => {
  it('dates', () => {
    expect(validateDates({ startDate: '', endDate: null }, false).map((i) => i.message)).toEqual(['Start date is required']);
    expect(validateDates({ startDate: '2026-11-10', endDate: null }, true).map((i) => i.message)).toEqual(['End date is required when Set End Date is checked']);
    expect(validateDates({ startDate: '2026-11-10', endDate: '2026-11-10' }, true).map((i) => i.message)).toEqual(['End date must be after start date']);
  });

  it('primary fields and the 10% MDR limit', () => {
    expect(validatePrimary(draft({ methodCode: '' }), false).map((i) => i.message)).toEqual(['Payment method is required']);
    expect(validatePrimary(draft({ mdrPct: -1 }), false).map((i) => i.message)).toEqual(['MDR % cannot be negative']);
    expect(validatePrimary(draft({ mdrPct: 10.5 }), false).map((i) => i.message)).toEqual(['MDR % cannot be more than 10%']);
    expect(validatePrimary(draft({ minimumFee: -1 }), false).map((i) => i.message)).toEqual(['Minimum fee cannot be negative']);
    expect(validatePrimary(draft({ technique: 'fixed_fee', fixedFee: 0 }), false).map((i) => i.message)).toEqual(['Fixed fee must be greater than 0']);
    expect(validatePrimary(draft({ technique: 'fixed_fee', currency: 'USD', fixedFee: 0 }), false).map((i) => i.message)).toEqual(['Fixed fee in USD must be greater than 0']);
    expect(validatePrimary(draft({ technique: 'variable_plus_fixed', fixedFee: -1 }), false).map((i) => i.message)).toEqual(['Fixed fee cannot be negative']);
  });

  it('warns above the usual maximum for the method', () => {
    const fpx = { code: 'fpx', name: 'FPX', flow: 'payin' as const, typicalMaxMdr: 1.8 };
    expect(mdrWarnings(draft({ mdrPct: 2 }), fpx)).toEqual(['FPX is usually priced at up to 1.8%. Check the MDR before saving.']);
    expect(mdrWarnings(draft({ mdrPct: 1.8 }), fpx)).toEqual([]);
  });

  it('volume tiers, with every message', () => {
    const t = (minVolume: number, maxVolume: number | null, mdrPct = 1, fixedFee = 0) => ({ minVolume, maxVolume, mdrPct, fixedFee });
    expect(validateTiers([]).map((i) => i.message)).toEqual(['At least one volume tier is required']);
    expect(validateTiers([t(-1, 10)]).map((i) => i.message)).toEqual(['Tier min volume cannot be negative']);
    expect(validateTiers([t(10, 10)]).map((i) => i.message)).toEqual(['Tier starting at 10 must end above its start volume']);
    expect(validateTiers([t(0, 10, -1)]).map((i) => i.message)).toEqual(['Tier MDR % cannot be negative']);
    expect(validateTiers([t(0, 10, 1, -1)]).map((i) => i.message)).toEqual(['Tier fixed fee cannot be negative']);
    expect(validateTiers([t(0, null), t(100, null)]).map((i) => i.message)).toEqual(['Tier starting at 100 overlaps with the open-ended tier starting at 0']);
    expect(validateTiers([t(0, 100), t(50, null)]).map((i) => i.message)).toEqual(['Volume tiers overlap: tier starting at 50 begins before the previous tier ends (100)']);
    expect(validateTiers([t(0, 100), t(150, null)]).map((i) => i.message)).toEqual(['Gap between volume tiers: previous ends at 100, next starts at 150']);
    expect(validateTiers([t(0, 100), t(100, null)])).toEqual([]);
  });
});

describe('effective periods (§4.2)', () => {
  it('classifies overlap and supersession, ignoring ended and rejected versions', () => {
    const open = version({ startDate: '2026-11-01' });
    const c = classifyPeriod(draft({ startDate: '2026-11-20' }), [open]);
    expect(c).toMatchObject({ kind: 'supersession', message: 'This new pricing configuration will supersede the existing pricing from 20/11/2026. The existing pricing will remain effective until 19/11/2026.' });
    expect(classifyPeriod(draft({ startDate: '2026-11-01' }), [open]).kind).toBe('overlap');
    const bounded = version({ startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(classifyPeriod(draft({ startDate: '2026-11-20' }), [bounded]).kind).toBe('overlap');
    expect(classifyPeriod(draft({ startDate: '2026-12-01' }), [bounded]).kind).toBe('none');
    expect(classifyPeriod(draft({ startDate: '2026-11-01' }), [version({ startDate: '2026-11-01', status: 'rejected' })]).kind).toBe('none');
    expect(classifyPeriod(draft({ startDate: '2026-11-01', methodCode: 'cards' }), [open]).kind).toBe('none');
    // The version being edited is excluded.
    expect(classifyPeriod(draft({ startDate: '2026-11-01' }), [open], open.id).kind).toBe('none');
  });

  it('VA banks: compared only when the bank sets intersect (empty = all)', () => {
    expect(vaBanksIntersect([], [])).toBe(true);
    expect(vaBanksIntersect([], ['va_bca'])).toBe(true);
    expect(vaBanksIntersect(['va_bca', 'va_bni'], ['va_bni'])).toBe(true);
    expect(vaBanksIntersect(['va_bca'], ['va_bni'])).toBe(false);
    const bca = version({ methodCode: 'va', vaBanks: ['va_bca'], startDate: '2026-11-01' });
    expect(classifyPeriod(draft({ methodCode: 'va', vaBanks: ['va_bni'], startDate: '2026-11-01' }), [bca]).kind).toBe('none');
    expect(classifyPeriod(draft({ methodCode: 'va', vaBanks: [], startDate: '2026-11-01' }), [bca]).kind).toBe('overlap');
  });

  it('supersedes on activation: an active approval expires the old version; a scheduled one ends it the day before', () => {
    const old = version({ startDate: '2026-11-01' });
    const now = version({ startDate: '2026-11-10', status: 'pending_approval', version: 2 });
    activateVersion(now, [old, now], '2026-11-10');
    expect([now.status, old.status, old.endDate]).toEqual(['active', 'expired', '2026-11-09']);

    const old2 = version({ startDate: '2026-11-01' });
    const later = version({ startDate: '2026-12-01', status: 'pending_approval', version: 2 });
    activateVersion(later, [old2, later], '2026-11-10');
    expect([later.status, old2.status, old2.endDate]).toEqual(['scheduled', 'active', '2026-11-30']);
  });

  it('runs the daily job: scheduled → active on the start date, active → expired after the end date', () => {
    const s = version({ status: 'scheduled', startDate: '2026-12-01' });
    const a = version({ status: 'active', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(runStatusJob([s, a], '2026-11-30')).toBe(0);
    expect(runStatusJob([s, a], '2026-12-01')).toBe(2);
    expect([s.status, a.status]).toEqual(['active', 'expired']);
  });
});

describe('summaries and the onboarding gate', () => {
  it('formats configuration summaries (§4.4)', () => {
    expect(pricingSummary(draft({ mdrPct: 1.5 }))).toBe('Percentage: 1.5%');
    expect(pricingSummary(draft({ technique: 'variable_plus_fixed', mdrPct: 1, fixedFee: 0.5 }))).toBe('Percentage + Fixed Fee: 1% + MYR 0.5');
    expect(pricingSummary(draft({ technique: 'fixed_fee', fixedFee: 1 }))).toBe('Fixed Fee: MYR 1');
    expect(pricingSummary({ ...draft({ technique: 'fixed_fee', currency: 'USD', fixedFee: 0.5 }), usd: { fixedFeeUsd: 0.5, usdExchangeRate: 16000, localEquivalent: 8000, localEquivalentCurrency: 'IDR' } })).toBe('Fixed Fee: USD 0.5 (Rate 16,000 → IDR 8,000)');
  });

  it('lists the three blocking messages and counts the badge', () => {
    const methods = [
      { code: 'fpx', name: 'FPX', flow: 'payin' as const, typicalMaxMdr: 1.8 },
      { code: 'bank_transfer_payout', name: 'Bank Transfer', flow: 'payout' as const, typicalMaxMdr: 5 },
    ];
    const off = { applicationId: 'A', products: methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: false })), settlement: {}, revision: 0, savedAt: null, savedBy: null };
    expect(productGaps(off, [], methods, '2026-11-10').map((g) => g.message)).toEqual(['Switch on at least one product before confirming.']);
    const on = { ...off, products: methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: true })) };
    const gaps = productGaps(on, [], methods, '2026-11-10');
    expect(gaps.map((g) => g.message)).toEqual(['Set pricing for every product before confirming: FPX, Bank Transfer.', 'Set a settlement cycle for every PayIn product before confirming: FPX.']);
    expect(gapCount(gaps)).toBe(3);
    const priced = [version({ methodCode: 'fpx' }), version({ methodCode: 'bank_transfer_payout', flow: 'payout' })];
    expect(productGaps({ ...on, settlement: { fpx: 'T+1' } }, priced, methods, '2026-11-10')).toEqual([]);
  });
});

describe('price resolution (§7.9)', () => {
  it('uses the sub-merchant rule, then the merchant-level rule, then none', () => {
    const merchant = version({ methodCode: 'cards', mdrPct: 2.2 });
    const sub = version({ methodCode: 'cards', mdrPct: 1.9, subMerchantId: 'ME-1' });
    expect(resolvePricing([merchant, sub], 'cards', '2026-11-10', 'payin', 'ME-1')).toMatchObject({ level: 'sub_merchant', version: { mdrPct: 1.9 } });
    expect(resolvePricing([merchant, sub], 'cards', '2026-11-10', 'payin', 'ME-2')).toMatchObject({ level: 'merchant', version: { mdrPct: 2.2 } });
    expect(resolvePricing([sub], 'cards', '2026-11-10', 'payin', null)).toBeNull();
  });

  it('keeps sub-merchant rules out of merchant-level overlap checks', () => {
    const sub = version({ methodCode: 'cards', subMerchantId: 'ME-1', startDate: '2026-11-01' });
    expect(classifyPeriod(draft({ methodCode: 'cards', startDate: '2026-11-01' }), [sub]).kind).toBe('none');
    expect(classifyPeriod(draft({ methodCode: 'cards', subMerchantId: 'ME-1', startDate: '2026-11-01' }), [sub]).kind).toBe('overlap');
  });
});
