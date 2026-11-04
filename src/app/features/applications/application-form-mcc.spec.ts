import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { emptyApplicationData } from '../../core/merchants/application-rules';
import { EMPTY_MCC_CATALOGUE, MccCatalogue, mccAvailability, catalogueCovers, mccOptionsFor } from '../../core/merchants/mcc';
import { MccService } from '../../core/merchants/mcc.service';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { CountryApplication, GlobalMerchant } from '../../core/merchants/merchant-models';
import { ApplicationForm } from './application-form';

const FIXTURE: MccCatalogue = {
  source: { kind: 'test_fixture', name: 'TEST FIXTURE – not an approved catalogue', version: 'test-1', loadedAt: 0 },
  entries: [
    { code: '5411', description: 'TEST – Grocery stores', countries: { MY: 'available' } },
    { code: '5732', description: 'TEST – Electronics stores', countries: { TH: 'available' } },
  ],
};

async function render(catalogue: MccCatalogue, locked = false, merchantMcc: { code: string; description: string } | null = null) {
  const state = signal(catalogue);
  const mcc = {
    catalogue: state.asReadonly(),
    isTestFixture: () => state().source?.kind === 'test_fixture',
    covers: (c: string) => catalogueCovers(state(), c),
    optionsFor: (c: string) => mccOptionsFor(state(), c),
    availability: (code: string, c: string) => mccAvailability(state(), code, c),
  };
  const api = {
    setMcc: vi.fn(async () => ({ id: 'GM-1', mcc: { code: '5411', description: 'TEST – Grocery stores' } })),
    submit: vi.fn(async () => ({ id: 'APP-1', status: 'pending_risk_review' })),
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MerchantApi, useValue: api }, { provide: MccService, useValue: mcc }] });
  const f = TestBed.createComponent(ApplicationForm);
  f.componentRef.setInput('application', { id: 'APP-1', merchantId: 'GM-1', country: 'MY', status: 'draft', data: emptyApplicationData('MY'), prefill: [], corrections: null } as unknown as CountryApplication);
  f.componentRef.setInput('merchant', { id: 'GM-1', legalName: 'Kedai Ujian Sdn Bhd', registrationCountry: 'MY', mcc: merchantMcc } as unknown as GlobalMerchant);
  f.componentRef.setInput('mccLocked', locked);
  await f.whenStable();
  const el = f.nativeElement as HTMLElement;
  const field = () => el.querySelector('.f-field:has(#mcc), .f-field:has(label[for="mcc"])') as HTMLElement;
  return { f, el, api, field };
}

describe('Application form – MCC field', () => {
  it('leaves MCC optional with an empty state when no catalogue covers the country, without inventing options', async () => {
    const { f, el, field } = await render(EMPTY_MCC_CATALOGUE);
    expect(field().querySelector('label .req')).toBeNull();
    const select = el.querySelector('#mcc') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['No MCCs available']);
    expect(field().textContent).toContain('No MCC catalogue covers Malaysia yet, so the MCC can be left empty.');
    expect((f.componentInstance as any).issues().some((i: any) => i.field === 'business.mcc')).toBe(false);
  });

  it('is required, with the catalogue options, where a catalogue covers the country', async () => {
    const { f, field } = await render(FIXTURE);
    expect(field().querySelector('label .req')).not.toBeNull();
    expect((f.componentInstance as any).issues().some((i: any) => i.field === 'business.mcc')).toBe(true);
  });

  it('sits with the other Business information fields, after Industry', async () => {
    const { el } = await render(FIXTURE);
    const labels = [...el.querySelectorAll('.f-grid label')].map((l) => l.getAttribute('for'));
    expect(labels.slice(0, 6)).toEqual(['tradingName', 'businessType', 'merchantCategory', 'industry', 'mcc', 'website']);
  });

  it('submits with MCC empty when no catalogue covers the country', async () => {
    const { f, api } = await render(EMPTY_MCC_CATALOGUE);
    const form = f.componentInstance as any;
    await form.submit(); // guided mode: the first click asks to confirm the other missing items
    await form.submit();
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it('offers the three merchant categories, requires one and saves the choice with the application', async () => {
    const { f, el } = await render(EMPTY_MCC_CATALOGUE);
    const form = f.componentInstance as any;
    const select = el.querySelector('#merchantCategory') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['Select merchant category', 'Payment Gateway & Business Entity (PGBE)', 'Payment Service Provider', 'Merchant']);
    expect(form.issues().find((i: any) => i.field === 'business.merchantCategory')?.message).toBe('Select the merchant category.');
    for (const value of ['pgbe', 'psp', 'merchant']) {
      select.value = value;
      select.dispatchEvent(new Event('change'));
      f.detectChanges();
      expect(form.data().business.merchantCategory).toBe(value);
      expect(form.issues().some((i: any) => i.field === 'business.merchantCategory')).toBe(false);
    }
  });

  it("offers only the country's codes and confirms the save (regression: no confirmation was shown)", async () => {
    const { f, el, api } = await render(FIXTURE);
    const options = [...el.querySelectorAll('#mcc option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Select MCC', '5411 – TEST – Grocery stores']);
    const select = el.querySelector('#mcc') as HTMLSelectElement;
    select.value = '5411';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      f.detectChanges();
      await f.whenStable();
      expect(el.querySelector('.f-hint.saved')?.textContent).toContain('MCC 5411 saved to Kedai Ujian Sdn Bhd.');
    });
    expect(api.setMcc).toHaveBeenCalledWith('GM-1', '5411');
  });

  it('after approval, sends MCC changes to a Risk request instead', async () => {
    const { el } = await render(FIXTURE, true);
    expect(el.querySelector('#mcc')).toBeNull();
    expect(el.textContent).toContain('the MCC can only change through a Risk-approved request');
  });
});
