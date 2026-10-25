import { ApplicationData, GlobalMerchant, VerificationCheck, VerificationEvidence } from '../merchants/merchant-models';
import { VERIFICATION_PROVIDER_LABEL } from '../merchants/onboarding-config';

// SIMULATED verification evidence. No external provider is called. Outcomes are derived
// from the application data so testers can reproduce them; Risk always makes the decision.
// Demo trigger: a person whose name contains "Flag" returns a screening match for review.

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(sdn|bhd|berhad|pt|tbk|jsc|co|ltd|limited|inc|corp|corporation|llc|pte|company)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

export function simulateVerification(merchant: Pick<GlobalMerchant, 'legalName' | 'registrationNumber'>, data: ApplicationData, at: number): VerificationEvidence {
  const checks: VerificationCheck[] = [];
  const regNo = data.business.localRegistrationNumber || merchant.registrationNumber;

  checks.push({
    name: 'Business registry lookup',
    result: regNo ? 'pass' : 'review',
    detail: regNo ? `Sample registry record found for ${regNo}; name matches "${merchant.legalName}".` : 'No registration number available to look up.',
  });

  const people = data.directors.length ? data.directors.map((d) => d.name) : [data.contact.name];
  const flagged = people.filter((n) => /flag/i.test(n));
  checks.push({
    name: 'Sanctions & PEP screening',
    result: flagged.length ? 'review' : 'pass',
    detail: flagged.length
      ? `Possible name match for ${flagged.join(', ')}. Manual review needed.`
      : `No matches for ${people.length} ${people.length === 1 ? 'person' : 'people'} screened.`,
  });

  const holder = norm(data.bank['accountName'] ?? '');
  const names = [norm(merchant.legalName), norm(data.business.tradingName)].filter(Boolean);
  const nameOk = !!holder && names.some((n) => n.includes(holder) || holder.includes(n));
  checks.push({
    name: 'Bank account name match',
    result: nameOk ? 'pass' : 'review',
    detail: nameOk ? 'Account holder name matches the registered name.' : `Account holder "${data.bank['accountName'] ?? ''}" differs from the registered name.`,
  });

  checks.push({
    name: 'Website & business activity check',
    result: data.business.website ? 'pass' : 'review',
    detail: data.business.website ? `${data.business.website} is reachable and consistent with "${data.business.industry}" (sample).` : 'No website provided; confirm the business activity manually.',
  });

  return { provider: VERIFICATION_PROVIDER_LABEL, simulated: true, ranAt: at, checks };
}
