import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { CountryApplication, GlobalMerchant, StaffRole } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { SubMerchantView } from '../../core/merchants/sub-merchants';
import { SubMerchantsPanel } from './sub-merchants-panel';

const sub = (over: Partial<SubMerchantView> = {}): SubMerchantView => ({
  id: 'ME-000090', displayName: 'Makati branch', legalEntity: null, email: 'makati@manila.test', website: 'https://makati.example', tradingLicenseUrl: null, country: 'PH', status: 'approved', createdVia: 'ops', createdBy: 'Sarah Lim', createdAt: 0,
  lifecycleStatus: 'active', lifecycleReason: null, goLiveChecks: [{ key: 'live_transaction', label: 'Live low-value test transaction succeeded', done: false, doneAt: null, doneBy: null }],
  history: [], mid: null, goLiveBlocker: null, parentApplicationId: 'APP-7', inherited: { products: [{ name: 'VietQR', pricing: 'Percentage: 0.6%', settlement: 'T+1' }] }, ...over,
});

async function render(role: StaffRole, subs: SubMerchantView[], merchant: Partial<GlobalMerchant> = {}, applications = [{ id: 'APP-7', country: 'PH', status: 'operational' }] as CountryApplication[], openId: string | null = null) {
  const api = { createSubMerchant: vi.fn(), subMerchantAction: vi.fn(async () => subs[0]) };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MerchantApi, useValue: api }, { provide: StaffRoleService, useValue: { role: () => role } }] });
  const f = TestBed.createComponent(SubMerchantsPanel);
  f.componentRef.setInput('merchant', { id: 'GM-1', legalName: 'Manila Learning Hub Inc.', lifecycleStatus: 'active', ...merchant } as GlobalMerchant);
  f.componentRef.setInput('applications', applications);
  f.componentRef.setInput('subMerchants', subs);
  f.componentRef.setInput('openId', openId);
  await f.whenStable();
  const el = f.nativeElement as HTMLElement;
  const settle = async () => {
    f.detectChanges();
    await f.whenStable();
  };
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement | undefined;
  return { api, el, settle, button, f };
}

describe('Sub-merchants panel', () => {
  it('registers a sub-merchant with business name, email, website, country of jurisdiction and an optional trading license link', async () => {
    const { api, el, settle, button } = await render('sales', []);
    api.createSubMerchant.mockResolvedValue(sub({ id: 'ME-000091', displayName: 'Cebu branch', status: 'pending_risk_review' }));
    button('Add sub-merchant')!.click();
    await settle();
    const labels = [...el.querySelectorAll('.sm-form label')].map((l) => l.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels).toEqual(['Business Name *', 'Email *', 'Website *', 'Country of Jurisdiction *', 'Trading license website link (Optional)']);
    expect([...el.querySelectorAll<HTMLOptionElement>('#sm-country option')].map((o) => o.value)).toEqual(['PH']);
    const type = (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(id)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('#sm-name', ' Cebu branch ');
    type('#sm-email', 'cebu@manila.test');
    type('#sm-website', 'https://cebu.example');
    button('Save and send to Risk')!.click();
    await settle();
    expect(api.createSubMerchant).toHaveBeenCalledWith('GM-1', { country: 'PH', displayName: 'Cebu branch', email: 'cebu@manila.test', website: 'https://cebu.example', tradingLicenseUrl: null, submit: true });
  });

  it('shows the registration details, and the legal identity only on older sub-merchants that have one', async () => {
    const { el, settle, button } = await render('risk', [sub({ tradingLicenseUrl: 'https://license.example/123', legalEntity: { legalName: 'Makati Learning Corp.', registrationNumber: 'CS2020' } })]);
    button('Details')!.click();
    await settle();
    const text = el.querySelector('.sm-detail')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toMatch(/Country of jurisdiction\s*Philippines/);
    expect(text).toMatch(/Email\s*makati@manila\.test/);
    expect(text).toMatch(/Website\s*https:\/\/makati\.example/);
    expect(text).toMatch(/Trading license\s*https:\/\/license\.example\/123/);
    expect(text).toMatch(/Legal identity\s*Makati Learning Corp\. \(CS2020\)/);
  });

  it('offers "Add sub-merchant" to Sales / Operations only while the parent is not suspended', async () => {
    expect((await render('sales', [])).button('Add sub-merchant')).toBeTruthy();
    TestBed.resetTestingModule();
    expect((await render('sales', [], { lifecycleStatus: 'suspended' })).button('Add sub-merchant')).toBeUndefined();
    TestBed.resetTestingModule();
    expect((await render('cs', [])).button('Add sub-merchant')).toBeUndefined();
  });

  it('shows CS why go-live is blocked and disables it', async () => {
    const { el, settle, button } = await render('cs', [sub({ goLiveBlocker: "Makati branch can't go live until Manila Learning Hub Inc. is operational in this country." })]);
    button('Details')!.click();
    await settle();
    expect(el.querySelector('.sm-blocker')?.textContent).toContain("can't go live until Manila Learning Hub Inc. is operational");
    expect(button('Go live')!.disabled).toBe(true);
    expect(el.textContent).toContain('VietQR · Percentage: 0.6% · settlement T+1');
  });

  it('lets Risk approve, and requires a reason to reject', async () => {
    const { api, el, settle, button } = await render('risk', [sub({ status: 'pending_risk_review' })]);
    button('Details')!.click();
    await settle();
    button('Reject')!.click();
    await settle();
    expect(api.subMerchantAction).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Give the reason for rejecting (at least 10 characters).');
    button('Approve')!.click();
    await settle();
    expect(api.subMerchantAction).toHaveBeenCalledWith('ME-000090', 'review', { decision: 'approve', comment: '' });
  });

  it('never shows the internal entity ID', async () => {
    const { el, settle, button } = await render('sales', [sub()]);
    button('Details')!.click();
    await settle();
    expect(el.textContent).not.toContain('ME-000090');
  });

  // Regression: "Add sub-merchant" used to disappear with no explanation.
  it('explains why a sub-merchant cannot be added, as the next step to take', async () => {
    const note = async (...args: Parameters<typeof render>) => {
      TestBed.resetTestingModule();
      return (await render(...args)).el.querySelector('.sm-note')?.textContent?.trim();
    };
    expect(await note('cs', [])).toBe('Sales / Operations add sub-merchants. Switch "View as" to Sales / Ops to add one.');
    expect(await note('sales', [], { lifecycleStatus: 'suspended' })).toBe("Manila Learning Hub Inc. is suspended, so it can't add sub-merchants. Risk must reactivate it first.");
    expect(await note('sales', [], {}, [])).toBe('Start a country application for Manila Learning Hub Inc. first. Sub-merchants are added in countries where the parent has applied.');
    expect(await note('sales', [], {}, [{ id: 'A', country: 'PH', status: 'rejected' }] as CountryApplication[])).toMatch(/^Start a country application/);
    expect(await note('sales', [])).toBeUndefined();
  });

  // Regression: links from the Approvals page didn't open the sub-merchant to review.
  it('opens the linked sub-merchant and names its parent', async () => {
    const { el } = await render('risk', [sub({ status: 'pending_risk_review' })], {}, undefined, 'ME-000090');
    expect(el.querySelector('.sm-detail')).toBeTruthy();
    expect(el.querySelector('.sm-detail')?.textContent).toContain('Manila Learning Hub Inc. · GMID GM-1');
  });

  // Regression: the merchant page header can start the add form directly.
  it('opens the add form from the merchant page action, only when allowed', async () => {
    const { el, settle, f } = await render('sales', []);
    f.componentInstance.startAdd();
    await settle();
    expect(el.querySelector('#sm-name')).toBeTruthy();
    expect(document.activeElement?.id).toBe('sm-name'); // regression: focus used to run before the form rendered
    TestBed.resetTestingModule();
    const cs = await render('cs', []);
    cs.f.componentInstance.startAdd();
    await cs.settle();
    expect(cs.el.querySelector('#sm-name')).toBeNull();
  });
});
