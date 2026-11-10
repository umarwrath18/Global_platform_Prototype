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
    { code: '5732', description: 'TEST – Electronics stores', countries: { VN: 'available' } },
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
  const field = () => el.querySelector('.f-field:has(label[for="mcc"])') as HTMLElement;
  return { f, el, api, field };
}

describe('Application form – MCC field', () => {
  it('leaves MCC optional with an empty state when no catalogue covers the country, without inventing options', async () => {
    const { f, el, field } = await render(EMPTY_MCC_CATALOGUE);
    expect(field().querySelector('label .req')).toBeNull();
    expect(el.querySelector('#mcc-options')).toBeNull();
    expect(field().textContent).toContain('No MCC catalogue covers Malaysia yet, so the MCC can be left empty.');
    expect((f.componentInstance as any).issues().some((i: any) => i.field === 'business.mcc')).toBe(false);
  });

  it('is required, with the catalogue options, where a catalogue covers the country', async () => {
    const { f, field } = await render(FIXTURE);
    expect(field().querySelector('label .req')).not.toBeNull();
    expect((f.componentInstance as any).issues().some((i: any) => i.field === 'business.mcc')).toBe(true);
  });

  it('sits with the other Business information fields, after Nature of business', async () => {
    const { el } = await render(FIXTURE);
    const labels = [...el.querySelectorAll('.f-grid > .f-field > label')].map((l) => l.getAttribute('for'));
    expect(labels).toEqual(['priority', 'tradingName', 'businessName', 'localReg', 'incorporated', 'businessType', 'taxId', 'taxId2', 'website', 'industry', 'mcc', 'address']);
  });

  it('submits with MCC empty when no catalogue covers the country, after the confirmation', async () => {
    const { f, el, api } = await render(EMPTY_MCC_CATALOGUE);
    const form = f.componentInstance as any;
    form.submit(); // guided mode: the first click asks to confirm the other missing items
    form.submit();
    f.detectChanges();
    const dialog = el.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.querySelector('h2')?.textContent).toBe('Confirmation');
    expect(dialog.textContent).toContain("You're about to register this merchant. Please confirm to proceed.");
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['No', 'Confirm & Register']);
    expect(api.submit).not.toHaveBeenCalled();
    await form.confirmSubmit();
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it('closes the confirmation with No and submits nothing', async () => {
    const { f, el, api } = await render(EMPTY_MCC_CATALOGUE);
    const form = f.componentInstance as any;
    form.confirmIncomplete.set(true);
    form.submit();
    f.detectChanges();
    ([...el.querySelectorAll('[role="alertdialog"] button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === 'No')!.click();
    f.detectChanges();
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('offers Enterprise, SME and Micro as the merchant category, requires one and saves the choice', async () => {
    const { f, el } = await render(EMPTY_MCC_CATALOGUE);
    const form = f.componentInstance as any;
    form.go('transaction');
    f.detectChanges();
    const select = el.querySelector('#merchantCategory') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['Select merchant category', 'Enterprise', 'SME', 'Micro']);
    expect(el.querySelector('#merchantCategory-hint')?.textContent).toBe("The merchant's business size, used for risk monitoring and limits.");
    expect(form.issues().find((i: any) => i.field === 'transaction.merchantCategory')?.message).toBe('Select the merchant category.');
    for (const value of ['enterprise', 'sme', 'micro']) {
      select.value = value;
      select.dispatchEvent(new Event('change'));
      f.detectChanges();
      expect(form.data().transaction.merchantCategory).toBe(value);
      expect(form.issues().some((i: any) => i.field === 'transaction.merchantCategory')).toBe(false);
    }
    const conn = el.querySelector('#connectionType') as HTMLSelectElement;
    expect([...conn.options].map((o) => o.textContent?.trim())).toEqual(['Select connection type', 'Direct Merchant', 'PSP', 'Payment Facilitator (aggregator)', 'Marketplace', 'Platform (SaaS)']);
  });

  it("offers only the country's codes, searchable, and confirms the save (regression: no confirmation was shown)", async () => {
    const { f, el, api } = await render(FIXTURE);
    const options = [...el.querySelectorAll('#mcc-options option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['5411 – TEST – Grocery stores']);
    const search = el.querySelector('#mcc') as HTMLInputElement;
    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(el.querySelectorAll('#mcc-options option')).toHaveLength(0);
    search.value = 'groc';
    search.dispatchEvent(new Event('input'));
    f.detectChanges();
    const select = el.querySelector('#mcc-options') as HTMLSelectElement;
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
    expect(el.querySelector('#mcc-options')).toBeNull();
    expect(el.textContent).toContain('the MCC can only change through a Risk-approved request');
  });
});
