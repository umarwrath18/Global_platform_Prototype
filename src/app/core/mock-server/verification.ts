import { ApplicationData, GlobalMerchant, VerificationCheck, VerificationEvidence } from '../merchants/merchant-models';
import { VERIFICATION_PROVIDER_LABEL } from '../merchants/onboarding-config';

// Verification checks run on each submission. In this build no external provider is called:
// outcomes are derived from the application data so they are reproducible, and Risk always
// makes the decision. Screening returns a possible match for names on WATCHLIST.

const WATCHLIST = ['tan ah kow', 'victor lim'];

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
    detail: regNo ? `Registry record found for ${regNo}; the name matches "${merchant.legalName}".` : 'No registration number to look up.',
  });

  const people = data.directors.length ? data.directors.map((d) => d.name) : [data.contact.name];
  const flagged = people.filter((n) => WATCHLIST.includes(n.trim().toLowerCase()));
  checks.push({
    name: 'Sanctions & PEP screening',
    result: flagged.length ? 'review' : 'pass',
    detail: flagged.length
      ? `Possible watchlist match for ${flagged.join(', ')}. Review before deciding.`
      : `No matches for ${people.length} ${people.length === 1 ? 'person' : 'people'} screened.`,
  });

  const holder = norm(data.bank['accountName'] ?? '');
  const names = [norm(merchant.legalName), norm(data.business.tradingName)].filter(Boolean);
  const nameOk = !!holder && names.some((n) => n.includes(holder) || holder.includes(n));
  checks.push({
    name: 'Bank account name match',
    result: nameOk ? 'pass' : 'review',
    detail: nameOk ? 'Account holder name matches the registered name.' : data.bank['accountName'] ? `Account holder "${data.bank['accountName']}" doesn't match the registered name.` : 'No bank account holder name provided.',
  });

  checks.push({
    name: 'Website & business activity check',
    result: data.business.website ? 'pass' : 'review',
    detail: data.business.website ? `${data.business.website} is live and consistent with ${data.business.industry.toLowerCase() || 'the declared business'}.` : 'No website provided. Confirm the business activity another way.',
  });

  return { provider: VERIFICATION_PROVIDER_LABEL, simulated: true, ranAt: at, checks };
}
