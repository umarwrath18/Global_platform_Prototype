import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyApplicationData } from '../../core/merchants/application-rules';
import { ApprovalsView, ChangeRequest } from '../../core/merchants/change-requests';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { CountryApplication, GlobalMerchant, StaffRole } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Approvals } from '../approvals/approvals';
import { ChangeRequestForm } from './change-request-form';
import { PendingChanges } from './pending-changes';

const request: ChangeRequest = {
  id: 'CR-0001', scope: 'country_details', section: 'bank', merchantId: 'GM-1', applicationId: 'APP-1', country: 'MY',
  changes: [{ field: 'bank.accountNumber', label: 'Account number', from: '•••• 5678', to: '•••• 5544' }],
  reason: 'Merchant moved banks', requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt: 0, status: 'pending', decidedBy: null, decidedRole: null, decidedAt: null, decisionComment: null,
};

function setup(role: StaffRole) {
  const api = { decideChange: vi.fn(async () => request), withdrawChange: vi.fn(async () => request), requestCountryChange: vi.fn(async () => request), getApprovals: vi.fn() };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MerchantApi, useValue: api }, { provide: StaffRoleService, useValue: { role: () => role } }] });
  return api;
}

async function settle(f: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  f.detectChanges();
  await f.whenStable();
}

const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement | undefined;

describe('Pending changes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows masked current and proposed values, and lets Risk decide (rejecting needs a reason)', async () => {
    const api = setup('risk');
    const f = TestBed.createComponent(PendingChanges);
    f.componentRef.setInput('changes', [request]);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.cr-table tbody')?.textContent).toContain('•••• 5678');
    expect(el.querySelector('.cr-table tbody')?.textContent).toContain('•••• 5544');
    button(el, 'Reject')!.click();
    await settle(f);
    expect(api.decideChange).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Give the reason for rejecting (at least 10 characters).');
    button(el, 'Approve and apply')!.click();
    await settle(f);
    expect(api.decideChange).toHaveBeenCalledWith('CR-0001', 'approve', '');
  });

  it('gives Sales / Operations a withdraw action and CS no actions', async () => {
    setup('sales');
    const f = TestBed.createComponent(PendingChanges);
    f.componentRef.setInput('changes', [request]);
    await settle(f);
    expect(button(f.nativeElement, 'Withdraw')).toBeTruthy();
    expect(button(f.nativeElement, 'Approve and apply')).toBeUndefined();

    TestBed.resetTestingModule();
    setup('cs');
    const g = TestBed.createComponent(PendingChanges);
    g.componentRef.setInput('changes', [request]);
    await settle(g);
    expect((g.nativeElement as HTMLElement).querySelectorAll('button')).toHaveLength(0);
    expect((g.nativeElement as HTMLElement).textContent).toContain('Nothing changes until Risk approves.');
  });
});

describe('Change request form', () => {
  afterEach(() => vi.restoreAllMocks());

  function application(): CountryApplication {
    const data = emptyApplicationData('MY');
    data.bank = { bankName: 'Maybank', accountName: 'Tanjung', accountNumber: '514012345678', swiftCode: '' };
    return { id: 'APP-1', merchantId: 'GM-1', country: 'MY', status: 'operational', data } as unknown as CountryApplication;
  }

  async function render() {
    const api = setup('sales');
    const f = TestBed.createComponent(ChangeRequestForm);
    f.componentRef.setInput('application', application());
    f.componentRef.setInput('merchant', { id: 'GM-1', registrationCountry: 'MY' } as GlobalMerchant);
    await settle(f);
    return { api, f, el: f.nativeElement as HTMLElement };
  }
  const type = (el: HTMLElement, sel: string, value: string) => {
    const i = el.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
    i.value = value;
    i.dispatchEvent(new Event('input'));
  };

  it('never shows the account number in full; blank keeps it, and only the section is sent', async () => {
    const { api, f, el } = await render();
    const acct = el.querySelector('#cr-bank-accountNumber') as HTMLInputElement;
    expect(acct.value).toBe('');
    expect(acct.placeholder).toBe('Current •••• 5678');
    expect(el.textContent).not.toContain('514012345678');
    type(el, '#cr-bank-bankName', 'CIMB Bank');
    type(el, '#cr-reason', 'Merchant moved banks this quarter');
    await settle(f);
    button(el, 'Send to Risk')!.click();
    await settle(f);
    expect(api.requestCountryChange).toHaveBeenCalledWith('APP-1', { section: 'bank', value: expect.objectContaining({ bankName: 'CIMB Bank', accountNumber: '' }), reason: 'Merchant moved banks this quarter' });
  });

  it('shows validation errors and asks before discarding a draft', async () => {
    const { api, f, el } = await render();
    type(el, '#cr-bank-accountNumber', '12');
    type(el, '#cr-reason', 'Merchant moved banks this quarter');
    await settle(f);
    button(el, 'Send to Risk')!.click();
    await settle(f);
    expect(api.requestCountryChange).not.toHaveBeenCalled();
    expect(el.querySelector('.f-error')?.textContent).toBeTruthy();
    expect((f.componentInstance as ChangeRequestForm).hasUnsavedChanges()).toBe(true);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    button(el, 'Directors')!.click();
    await settle(f);
    expect(confirm).toHaveBeenCalledWith('Discard the changes to this section?');
    expect(el.querySelector('#cr-bank-accountNumber')).toBeTruthy();
  });
});

describe('Approvals page', () => {
  it('lists what is waiting for the acting team with a link to decide', async () => {
    const api = setup('finops');
    const view: ApprovalsView = {
      heading: 'Waiting for FinOps', canDecide: true, recent: [],
      pending: [{ kind: 'pricing', id: 'PV-000009', title: 'Pricing change · Indonesia', merchantId: 'GM-1', merchantName: 'PT Rasa Bali Kuliner', applicationId: 'APP-9', country: 'ID', summary: 'Visa / Mastercard: 2.4% MDR from 2026-10-28', requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt: 0, status: 'pending', approverTeam: 'finops', decidedAt: null, link: ['/applications', 'APP-9', 'products'] }],
    };
    api.getApprovals.mockResolvedValue(view);
    const f = TestBed.createComponent(Approvals);
    await settle(f);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#pending-title')?.textContent).toContain('Waiting for FinOps');
    expect(el.textContent).toContain('Visa / Mastercard: 2.4% MDR from 2026-10-28');
    expect(el.querySelector('a.btn')?.getAttribute('href')).toBe('/applications/APP-9/products');
  });
});
