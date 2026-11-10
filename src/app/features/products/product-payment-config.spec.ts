import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { PricingMode, PricingVersion, ProductPricingView } from '../../core/merchants/products';
import { PricingEditor } from './pricing-editor';
import { PricingPanel } from './pricing-panel';
import { ProductsCard } from './products-card';

const NOW = Date.UTC(2026, 10, 10, 9);
const TODAY = '2026-11-10';

function version(methodCode: string, over: Partial<PricingVersion> = {}): PricingVersion {
  return {
    flow: 'payin', methodCode, vaBanks: [], technique: 'variable_rate', currency: 'MYR', mdrPct: 2.2, fixedFee: null, minimumFee: 0, volumePeriod: null, tiers: null, historical: null, subscription: null, promotion: null,
    startDate: '2026-11-01', endDate: null, id: `PV-${methodCode}`, applicationId: 'APP-1', version: 1, status: 'active', usd: null, source: 'onboarding', settlementSnapshot: null, editOf: null,
    createdBy: 'x', createdById: 'u', createdRole: 'cs', createdAt: NOW - 1000, approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null, cancelledBy: null, cancelledAt: null, ...over,
  };
}

/** Malaysia: Cards and FPX switched on; Cards priced, FPX not; DuitNow and the payout off. */
function makeView(mode: PricingMode = 'onboarding', over: Partial<ProductPricingView> = {}): ProductPricingView {
  return {
    applicationId: 'APP-1', merchantId: 'GM-1', merchantName: 'Kedai Ujian Sdn Bhd', mid: null, country: 'MY', countryName: 'Malaysia', currency: 'MYR',
    status: mode === 'onboarding' ? 'cs_configuration' : 'operational', mode, suspended: false, notice: '', inferred: false,
    methods: [
      { code: 'cards', name: 'Cards', flow: 'payin', typicalMaxMdr: 3.5 },
      { code: 'fpx', name: 'FPX', flow: 'payin', typicalMaxMdr: 1.8 },
      { code: 'duitnow_qr', name: 'DuitNow QR', flow: 'payin', typicalMaxMdr: 1.5 },
      { code: 'bank_transfer_payout', name: 'Bank Transfer', flow: 'payout', typicalMaxMdr: 5 },
    ],
    config: {
      applicationId: 'APP-1',
      products: [
        { methodCode: 'cards', flow: 'payin', enabled: true },
        { methodCode: 'fpx', flow: 'payin', enabled: true },
        { methodCode: 'duitnow_qr', flow: 'payin', enabled: false },
        { methodCode: 'bank_transfer_payout', flow: 'payout', enabled: false },
      ],
      settlement: { cards: 'T+1' },
      revision: 1, savedAt: NOW, savedBy: 'x',
    },
    versions: [version('cards')],
    gaps: [], gapCount: 0,
    can: { editProducts: true, editPricing: true, decidePricing: false },
    productsMessage: null, pricingMessage: null, usdRate: 4.2, today: TODAY, now: NOW,
    ...over,
  };
}

async function render<T>(component: new (...args: any[]) => T, inputs: Record<string, unknown>) {
  const api = { saveProducts: vi.fn(async () => ({ message: 'ok', view: inputs['view'] })), setPricing: vi.fn(), cancelPricing: vi.fn() };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MerchantApi, useValue: api }] });
  const fixture = TestBed.createComponent(component);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement | undefined;
  return { fixture, el, api, settle, button };
}

describe('Products card (§8.2, §8.3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows PayIn and PayOut rows, the count, Priced tags and drafts', async () => {
    const { el, settle, button } = await render(ProductsCard, { view: makeView() });
    expect(el.querySelector('.step-meta')?.textContent).toContain('2 of 4 switched on');
    expect([...el.querySelectorAll('.flow-label')].map((x) => x.textContent?.trim())).toEqual(['PayIn – Collections', 'PayOut – Disbursements']);
    expect(el.querySelector('.p-chip.on .p-state.priced')?.textContent?.trim()).toBe('Priced');
    expect(el.textContent).not.toContain('Needs pricing');
    button('DuitNow QR')!.click();
    button('FPX')!.click();
    await settle();
    expect([...el.querySelectorAll('.p-state.unsaved')].map((x) => x.textContent?.trim())).toEqual(['Off – not saved', 'Not saved']);
    expect(el.querySelector('.foot-status')?.textContent).toContain('Save products before setting their settlement and pricing.');
    expect(button('Save products')).toBeTruthy();
    expect(button('Discard')).toBeTruthy();
  });

  it('asks before switching off a product whose pricing will be cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { settle, button, api } = await render(ProductsCard, { view: makeView() });
    button('Cards')!.click();
    await settle();
    button('Save products')!.click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('Switching off Cards will cancel its pricing. Continue?');
    expect(api.saveProducts).not.toHaveBeenCalled();
  });

  it('after onboarding, locks a product with active pricing and explains why', async () => {
    const { button } = await render(ProductsCard, { view: makeView('change') });
    const chip = button('Cards')!;
    expect(chip.disabled).toBe(true);
    expect(chip.title).toBe('Has active pricing – cannot be switched off after onboarding.');
  });

  it('shows settlement drafts with the count of unsaved changes', async () => {
    const { el, settle } = await render(ProductsCard, { view: makeView() });
    const select = el.querySelector('select[aria-label="Settlement cycle for Cards"]') as HTMLSelectElement;
    select.value = 'T+3';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(el.querySelector('.foot-status')?.textContent).toContain('1 settlement change(s) not saved.');
    expect(el.textContent).toContain('Settlement changes apply once saved and are recorded in the audit trail.');
  });
});

describe('Pricing table (§8.4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists unpriced products as amber rows with "Set pricing", and versions with technique, pricing and period', async () => {
    const { el } = await render(PricingPanel, { view: makeView() });
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('FPX');
    expect(rows[0]).toContain('No pricing yet');
    expect(rows[0]).toContain('Not priced');
    expect(rows[0]).toContain('Set pricing');
    expect(rows[1]).toContain('Cards PayIn · v1');
    expect(rows[1]).toContain('Percentage');
    expect(rows[1]).toContain('MDR: 2.2%');
    expect(rows[1]).toContain('01 Nov 2026 – Ongoing');
  });

  it('disables Edit while a version is pending, and never offers Cancel on active pricing in change mode', async () => {
    const v = makeView('change', { versions: [version('cards'), version('cards', { id: 'PV-2', version: 2, status: 'pending_approval', startDate: '2026-11-12' })] });
    const { el } = await render(PricingPanel, { view: v });
    const active = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('v1'))!;
    expect([...active.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([]);
    const pending = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('v2'))!;
    expect(pending.textContent).toContain('Pending FinOps approval');
    expect([...pending.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Cancel']);
  });

  it('shows the empty state when nothing is switched on', async () => {
    const v = makeView('onboarding', { versions: [], config: { ...makeView().config, products: makeView().config.products.map((p) => ({ ...p, enabled: false })) } });
    const { el } = await render(PricingPanel, { view: v });
    expect(el.textContent).toContain('No pricing set for this MID yet. Switch on its products above, then add pricing for each one.');
  });
});

describe('Pricing editor (§7.4, §8.5)', () => {
  afterEach(() => vi.restoreAllMocks());

  const editor = (preset: object, view = makeView()) => render(PricingEditor, { view, preset });

  it('walks Scope → Technique → Configure Rules → Summary, with the scope summary and six methods', async () => {
    const { el, settle, button } = await editor({ flow: 'payin', methodCode: 'fpx', editOf: null });
    expect(el.querySelector('.scope-strip')?.textContent).toContain('Corridor: 🇲🇾 Malaysia | Currency: MYR');
    expect(el.querySelector('.scope-sum')?.textContent?.trim()).toBe('Scope: Malaysia / Kedai Ujian Sdn Bhd (Merchant Level) / PayIn / FPX');
    button('Next')!.click();
    await settle();
    expect([...el.querySelectorAll('.t-card strong')].map((x) => x.textContent)).toEqual(['Percentage', 'Fixed Fee', 'Percentage + Fixed Fee', 'Higher of Percentage or Fixed Fee', 'Volume-Based (Waterfall)', 'Historical Volume']);
    button('Next')!.click();
    await settle();
    expect(el.textContent).toContain('No end date = open-ended pricing (applies indefinitely until superseded or deactivated).');
    (el.querySelector('#pe-mdr') as HTMLInputElement).value = '-1';
    el.querySelector('#pe-mdr')!.dispatchEvent(new Event('input'));
    button('Next')!.click();
    await settle();
    expect(el.querySelector('.alert.danger')?.textContent).toContain('Please fix the following errors:');
    expect(el.querySelector('.alert.danger')?.textContent).toContain('MDR % cannot be negative');
    (el.querySelector('#pe-mdr') as HTMLInputElement).value = '1.2';
    el.querySelector('#pe-mdr')!.dispatchEvent(new Event('input'));
    button('Next')!.click();
    await settle();
    expect(el.querySelector('.calc-fee')?.textContent).toContain('MYR 1,200.00');
    expect(button('Next: Secondary Charges')).toBeTruthy();
  });

  it('offers USD only for Fixed Fee and shows the local equivalent (USD-1 to USD-3)', async () => {
    const { el, settle, button } = await editor({ flow: 'payin', methodCode: 'fpx', editOf: null });
    button('Next')!.click();
    await settle();
    expect(el.querySelector('#pe-cur')).toBeNull();
    button('Percentage')!.click();
    button('Next')!.click();
    await settle();
    expect([...(el.querySelector('#pe-cur') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['MYR']);
    button('Back')!.click();
    await settle();
    [...el.querySelectorAll<HTMLButtonElement>('.t-card')].find((b) => b.textContent?.includes('Charge a fixed amount'))!.click();
    button('Next')!.click();
    await settle();
    const cur = el.querySelector('#pe-cur') as HTMLSelectElement;
    expect([...cur.options].map((o) => o.value)).toEqual(['MYR', 'USD']);
    cur.value = 'USD';
    cur.dispatchEvent(new Event('change'));
    (el.querySelector('#pe-fixed') as HTMLInputElement).value = '2';
    el.querySelector('#pe-fixed')!.dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('label[for="pe-fixed"]')?.textContent).toBe('Fixed Fee per Transaction (USD)');
    expect(el.textContent).toContain('8.40 MYR');
    expect(el.textContent).toContain('Auto-calculated: USD × 4.2 MYR/USD');
  });

  it('when editing, locks scope and technique, starts tomorrow and explains the new version', async () => {
    const v = makeView('change');
    const { el } = await editor({ flow: 'payin', methodCode: 'cards', editOf: 'PV-cards' }, v);
    expect(el.querySelector('#editor-title')?.textContent).toBe('Edit Pricing (new version of v1)');
    expect(el.textContent).toContain('Changes will create v2 effective from the new date. The pricing method (Percentage) cannot be changed.');
    expect((el.querySelector('#pe-start') as HTMLInputElement).value).toBe('2026-11-11');
    expect(el.querySelector('.t-card')).toBeNull();
  });
});
