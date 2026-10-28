import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { CountryApplication, GlobalMerchant, StaffRole } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { SubMerchantView } from '../../core/merchants/sub-merchants';
import { SubMerchantsPanel } from './sub-merchants-panel';

const sub = (over: Partial<SubMerchantView> = {}): SubMerchantView => ({
  id: 'ME-000090', displayName: 'Makati branch', legalEntity: null, country: 'PH', status: 'approved', createdVia: 'ops', createdBy: 'Sarah Lim', createdAt: 0,
  lifecycleStatus: 'active', lifecycleReason: null, goLiveChecks: [{ key: 'live_transaction', label: 'Live low-value test transaction succeeded', done: false, doneAt: null, doneBy: null }],
  history: [], mid: null, goLiveBlocker: null, parentApplicationId: 'APP-7', inherited: { products: [{ name: 'GCash', mdrPct: 2, settlement: 'T+1' }] }, ...over,
});

async function render(role: StaffRole, subs: SubMerchantView[], merchant: Partial<GlobalMerchant> = {}) {
  const api = { createSubMerchant: vi.fn(), subMerchantAction: vi.fn(async () => subs[0]) };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MerchantApi, useValue: api }, { provide: StaffRoleService, useValue: { role: () => role } }] });
  const f = TestBed.createComponent(SubMerchantsPanel);
  f.componentRef.setInput('merchant', { id: 'GM-1', legalName: 'Manila Learning Hub Inc.', lifecycleStatus: 'active', ...merchant } as GlobalMerchant);
  f.componentRef.setInput('applications', [{ id: 'APP-7', country: 'PH', status: 'operational' }] as CountryApplication[]);
  f.componentRef.setInput('subMerchants', subs);
  await f.whenStable();
  const el = f.nativeElement as HTMLElement;
  const settle = async () => {
    f.detectChanges();
    await f.whenStable();
  };
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement | undefined;
  return { api, el, settle, button };
}

describe('Sub-merchants panel', () => {
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
    expect(el.textContent).toContain('GCash · 2% MDR · settlement T+1');
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
});
