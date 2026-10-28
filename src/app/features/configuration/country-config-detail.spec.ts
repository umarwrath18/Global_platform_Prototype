import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountryConfigDetail } from '../../core/merchants/country-config';
import { CountryConfigService } from '../../core/merchants/country-config.service';
import { defaultCountryConfig, resetCountryConfigs } from '../../core/merchants/onboarding-config';
import { CountryConfigDetailPage } from './country-config-detail';

// The page is exercised with the server replaced by a stub; `canEdit` stands in for the
// server's decision (true only when acting as Sales / Operations).

function detail(canEdit: boolean): CountryConfigDetail {
  return { config: { ...defaultCountryConfig('MY')!, onboardingEnabled: true }, onboardingEnabled: true, version: 1, updatedAt: null, updatedBy: null, history: [], canEdit };
}

async function render(canEdit: boolean) {
  const service = { get: vi.fn(async () => detail(canEdit)), update: vi.fn(async () => detail(canEdit)) };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: CountryConfigService, useValue: service }] });
  const fixture = TestBed.createComponent(CountryConfigDetailPage);
  fixture.componentRef.setInput('code', 'MY');
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
  const type = (selector: string, value: string) => {
    const input = el.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const toggle = (selector: string) => {
    const input = el.querySelector(selector) as HTMLInputElement;
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
  };
  return { fixture, el, service, settle, button, type, toggle };
}

describe('CountryConfigDetailPage', () => {
  afterEach(() => resetCountryConfigs());

  it('is view only without the permission', async () => {
    const { el, button } = await render(false);
    expect(el.textContent).toContain('SSM company profile');
    expect(el.textContent).toContain('View only');
    expect(button('Edit rules')).toBeUndefined();
  });

  it('saves edits with the version and reason when the user has the permission', async () => {
    const { el, service, settle, button, type, toggle } = await render(true);
    button('Edit rules')!.click();
    await settle();

    toggle('.config-form input[type=checkbox]'); // Open for new applications -> off
    toggle('input[aria-label="Required: SST registration certificate"]');
    type('#cc-reason', 'Risk policy update R-12');
    await settle();
    button('Save changes')!.click();
    await settle();

    expect(service.update).toHaveBeenCalledTimes(1);
    const [code, req] = service.update.mock.calls[0] as unknown as [string, any];
    expect(code).toBe('MY');
    expect(req).toMatchObject({ onboardingEnabled: false, version: 1, reason: 'Risk policy update R-12' });
    expect(req.documents.find((d: any) => d.type === 'sst_certificate').required).toBe(true);
    await vi.waitFor(async () => {
      await settle();
      expect(el.textContent).toContain('Malaysia configuration saved');
    });
    expect(el.querySelector('.config-form')).toBeNull();
  });

  it('shows field errors and does not save invalid rules', async () => {
    const { el, service, settle, button, type } = await render(true);
    button('Edit rules')!.click();
    await settle();

    button('Add document type')!.click();
    await settle();
    type('#cc-doc-4-type', 'Bad Type');
    type('#cc-localRegistration-pattern', '^(\\d+');
    await settle();
    button('Save changes')!.click();
    await settle();

    expect(service.update).not.toHaveBeenCalled();
    const errors = [...el.querySelectorAll('.f-error')].map((e) => e.textContent?.trim());
    expect(errors).toEqual(
      expect.arrayContaining([
        'This format pattern is not a valid regular expression.',
        'Use a lowercase key with letters, digits or underscores, e.g. bank_statement.',
        'Enter a label.',
        'Enter a reason with at least 5 characters.',
      ]),
    );
  });
});
