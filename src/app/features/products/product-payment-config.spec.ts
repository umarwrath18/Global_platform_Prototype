import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { PricingVersionView, ProductPhase, ProductPricingView } from '../../core/merchants/products';
import { PricingPanel } from './pricing-panel';
import { ProductsCard } from './products-card';

const NOW = Date.UTC(2026, 9, 28, 9);

function version(methodCode: string, over: Partial<PricingVersionView> = {}): PricingVersionView {
  return {
    id: `PV-${methodCode}`, applicationId: 'APP-1', methodCode, flow: 'payin', mdrPct: 1, effectiveFrom: NOW - 1000, state: 'approved', settlementCycleAtCreation: null,
    source: 'onboarding', createdBy: 'x', createdRole: 'cs', createdAt: NOW - 1000, decidedBy: null, decidedRole: null, decidedAt: null, decisionComment: null,
    cancelledBy: null, cancelledAt: null, cancelReason: null, status: 'active', effectiveTo: null, ...over,
  };
}

/** Malaysia-like view: FPX and Cards switched on; Cards priced, FPX not; DuitNow off. */
function makeView(phase: ProductPhase = 'onboarding', over: Partial<ProductPricingView> = {}): ProductPricingView {
  return {
    applicationId: 'APP-1', country: 'MY', countryName: 'Malaysia', status: phase === 'onboarding' ? 'cs_configuration' : 'operational', phase, inferred: false,
    methods: [
      { code: 'MY_CARDS', name: 'Visa / Mastercard', flow: 'payin', minMdr: 1.5, maxMdr: 3.5 },
      { code: 'MY_FPX', name: 'FPX online banking', flow: 'payin', minMdr: 0.6, maxMdr: 1.8 },
      { code: 'MY_DUITNOW', name: 'DuitNow QR', flow: 'payin', minMdr: 0.5, maxMdr: 1.5 },
    ],
    config: {
      applicationId: 'APP-1',
      products: [
        { methodCode: 'MY_CARDS', flow: 'payin', enabled: true },
        { methodCode: 'MY_FPX', flow: 'payin', enabled: true },
        { methodCode: 'MY_DUITNOW', flow: 'payin', enabled: false },
      ],
      settlement: { MY_CARDS: 'T+1' },
      revision: 1, savedAt: NOW, savedBy: 'x',
    },
    versions: [version('MY_CARDS', { mdrPct: 2.2 })],
    gaps: [],
    can: { editProducts: true, editPricing: true, decidePricing: false },
    readOnlyReason: null,
    now: NOW,
    ...over,
  };
}

async function render<T>(component: new (...args: any[]) => T, view: ProductPricingView) {
  const api = { saveProducts: vi.fn(), setPricing: vi.fn(), cancelPricing: vi.fn(), decidePricing: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: MerchantApi, useValue: api }] });
  const fixture = TestBed.createComponent(component);
  fixture.componentRef.setInput('view', view);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement | undefined;
  const buttons = (text: string) => [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement[];
  return { fixture, el, api, settle, button, buttons };
}

describe('Products card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the count, PayOut as not configured, and draft states with the right save action', async () => {
    const { el, settle, button } = await render(ProductsCard, makeView());
    expect(el.querySelector('.step-meta')?.textContent).toContain('2 of 3 switched on');
    expect(el.textContent).toContain('No payout methods configured for Malaysia.');
    expect(el.querySelector('.p-chip.on .p-state.priced')?.textContent).toContain('✓ Priced');
    expect(el.textContent).not.toContain('Needs pricing');
    // FPX is saved and switched on but has no settlement cycle.
    expect(el.querySelector('.settle-box.missing')?.textContent).toContain('FPX online banking');

    button('DuitNow QR')!.click();
    await settle();
    expect(el.querySelector('.p-chip.changed .p-state.unsaved')?.textContent).toContain('Not saved');
    expect(button('Save products')).toBeTruthy();

    const select = el.querySelector('select[aria-label="Settlement cycle for FPX online banking"]') as HTMLSelectElement;
    select.value = 'T+2';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(button('Save changes')).toBeTruthy();

    button('Discard')!.click();
    await settle();
    expect(el.querySelector('.step-foot')).toBeNull();
    expect(el.querySelector('.p-chip.changed')).toBeNull();
  });

  it('asks before switching off a priced product during onboarding', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { el, settle, button } = await render(ProductsCard, makeView());
    button('Visa / Mastercard')!.click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('Switch off Visa / Mastercard? Its pricing will be cancelled when you save.');
    expect(el.querySelector('.p-chip.changed')).toBeNull();
  });

  it('after onboarding, locks a product with active pricing and explains why', async () => {
    const { button } = await render(ProductsCard, makeView('post_handoff'));
    const chip = button('Visa / Mastercard')!;
    expect(chip.disabled).toBe(true);
    expect(chip.title).toBe("Visa / Mastercard has active pricing, so it can't be switched off after onboarding.");
    expect(button('FPX online banking')!.disabled).toBe(false);
  });
});

describe('Pricing panel and inline editor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists unpriced switched-on products with "Set pricing", and opens the editor preselected', async () => {
    const { el, settle, button } = await render(PricingPanel, makeView());
    const row = el.querySelector('tr.unpriced')!;
    expect(row.textContent).toContain('FPX online banking');
    expect(row.textContent).toContain('No pricing yet');
    expect(row.querySelector('.status')?.textContent).toContain('Not priced');
    expect(el.textContent).not.toContain('DuitNow QR'); // switched off: neither priced nor listed

    button('Set pricing')!.click();
    await settle();
    expect(el.querySelector('app-pricing-editor')).toBeTruthy();
    expect(el.querySelector('.step-bar .current')?.textContent).toContain('MDR'); // product preselected
    expect(el.querySelector('label[for="pe-mdr"]')?.textContent).toContain('FPX online banking');
    expect(el.querySelector('tr.unpriced.active-row')).toBeTruthy();
    // Conflicting actions are disabled while the editor is open.
    expect(button('Add pricing')!.disabled).toBe(true);
    expect(button('Edit')!.disabled).toBe(true);
  });

  it('lists only switched-on products and disables a flow with none', async () => {
    const { el, settle, button } = await render(PricingPanel, makeView());
    button('Add pricing')!.click();
    await settle();
    const options = [...el.querySelectorAll('#pe-method option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Select a switched-on product', 'Visa / Mastercard', 'FPX online banking']);
    const payout = [...el.querySelectorAll('.seg button')].find((b) => b.textContent?.includes('PayOut')) as HTMLButtonElement;
    expect(payout.disabled).toBe(true);
  });

  it('ignores Escape, and asks before discarding a draft that has progressed', async () => {
    const { el, settle, button, fixture } = await render(PricingPanel, makeView());
    button('Set pricing')!.click();
    await settle();
    const mdr = el.querySelector('#pe-mdr') as HTMLInputElement;
    mdr.value = '1.2';
    mdr.dispatchEvent(new Event('input'));
    await settle();

    el.querySelector('app-pricing-editor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(el.querySelector('app-pricing-editor')).toBeTruthy();
    expect((fixture.componentInstance as PricingPanel).hasUnsavedChanges()).toBe(true);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const cancel = () => (el.querySelector('.editor-head .btn') as HTMLButtonElement).click();
    cancel();
    await settle();
    expect(confirm).toHaveBeenCalledWith('Discard this pricing draft?');
    expect(el.querySelector('app-pricing-editor')).toBeTruthy();
    cancel();
    await settle();
    expect(el.querySelector('app-pricing-editor')).toBeNull();
  });

  it('closes a draft that has not progressed without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { el, settle, button } = await render(PricingPanel, makeView());
    button('Add pricing')!.click();
    await settle();
    (el.querySelector('.editor-head .btn') as HTMLButtonElement).click();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(el.querySelector('app-pricing-editor')).toBeNull();
  });

  it('shows FinOps approve and reject only for pending pricing, and no editing', async () => {
    const view = makeView('post_handoff', {
      can: { editProducts: false, editPricing: false, decidePricing: true },
      versions: [version('MY_CARDS', { mdrPct: 2.2 }), version('MY_FPX', { id: 'PV-9', state: 'pending_approval', status: 'pending_approval', mdrPct: 1.1 })],
    });
    const { button, buttons } = await render(PricingPanel, view);
    expect(button('Add pricing')).toBeUndefined();
    expect(button('Edit')).toBeUndefined();
    expect(buttons('Approve')).toHaveLength(1);
    expect(buttons('Reject')).toHaveLength(1);
  });
});
