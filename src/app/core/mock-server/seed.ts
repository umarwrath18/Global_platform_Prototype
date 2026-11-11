import { AccountStatus, CountryAccess, UserStatus } from '../api/models';

// Seed accounts and users. All seeded users share the password below.
export const DEMO_PASSWORD = 'Mobi@123';

export const BASE_CURRENCY = 'USD';

export const COUNTRY_CATALOGUE: Record<string, Omit<CountryAccess, 'status'>> = {
  MY: { code: 'MY', name: 'Malaysia', currency: 'MYR' },
  ID: { code: 'ID', name: 'Indonesia', currency: 'IDR' },
  VN: { code: 'VN', name: 'Vietnam', currency: 'VND' },
  TH: { code: 'TH', name: 'Thailand', currency: 'THB' },
  PH: { code: 'PH', name: 'Philippines', currency: 'PHP' },
};

// Roles are placeholders until the role-to-permission matrix is approved.
export const ROLES: Record<string, { name: string; permissions: string[] }> = {
  'role-admin': { name: 'Administrator (placeholder)', permissions: [] },
  'role-viewer': { name: 'Viewer (placeholder)', permissions: [] },
  'role-merchant': { name: 'Merchant user', permissions: ['merchant_portal.view', 'merchant_portal.export'] },
};

export interface SeedAccount {
  id: string;
  name: string;
  status: AccountStatus;
  countries: { code: string; status: CountryAccess['status'] }[];
}

export interface SeedUser {
  id: string;
  accountId: string;
  loginId: string;
  name: string;
  email: string;
  roleId: string;
  status: UserStatus;
  /** Prototype-only behaviour hooks for demonstrating failure states. */
  demo?: 'service-outage' | 'otp-delivery-failure';
  /** Starts with an authenticator already registered (others must set one up at first sign-in). */
  mfaEnrolled?: boolean;
  /**
   * `merchant`: a merchant's own user, who sees only the Merchant Portal (Dashboard, My Transactions)
   * for `merchantId`. Absent: an internal Global Platform user (today's demo users).
   */
  portal?: 'merchant';
  merchantId?: string;
  /**
   * Internal users only: the team this login works as. The server applies it whatever the
   * screen sends. `admin`: a prototype admin who may switch teams with "View as". Absent: Sales / Ops.
   */
  team?: StaffTeam;
}

/** Internal teams a login can belong to (merchant teams, Mobi Support, Security Admin) or the prototype admin. */
export type StaffTeam = 'sales' | 'risk' | 'cs' | 'finops' | 'support' | 'security' | 'admin';

export const STAFF_TEAM_LABEL: Record<StaffTeam, string> = {
  sales: 'Sales / Operations',
  risk: 'Risk',
  cs: 'Customer Success',
  finops: 'FinOps',
  support: 'Mobi Support',
  security: 'Security Admin (Tech)',
  admin: 'Prototype admin (any team)',
};

export const SEED_ACCOUNTS: SeedAccount[] = [
  {
    id: 'GA-1001',
    name: 'Tanjung Global Trading Sdn Bhd',
    status: 'active',
    countries: [
      { code: 'MY', status: 'active' },
      { code: 'ID', status: 'active' },
      { code: 'VN', status: 'active' },
    ],
  },
  {
    id: 'GA-2002',
    name: 'Seri Mutiara Retail Sdn Bhd',
    status: 'suspended',
    countries: [{ code: 'MY', status: 'active' }],
  },
  {
    id: 'GA-3003',
    name: 'PT Nusa Pangan Lestari',
    status: 'inactive',
    countries: [{ code: 'ID', status: 'active' }],
  },
  {
    id: 'GA-1005',
    name: 'Nusantara Home Retail Sdn Bhd',
    status: 'active',
    countries: [
      { code: 'MY', status: 'active' },
      { code: 'ID', status: 'active' },
    ],
  },
  {
    id: 'GA-4004',
    name: 'Lumi Home Living Sdn Bhd',
    status: 'active',
    countries: [
      { code: 'MY', status: 'pending' },
      { code: 'VN', status: 'failed' },
    ],
  },
];

export const SEED_USERS: SeedUser[] = [
  { id: 'U-1', accountId: 'GA-1001', loginId: '123', name: 'Sarah Lim', email: 'sarah.lim@tanjungtrading.example', roleId: 'role-admin', status: 'active', team: 'sales' },
  { id: 'U-2', accountId: 'GA-1001', loginId: 'TANJUNG-ADMIN', name: 'Aisyah Rahman', email: 'aisyah@tanjungtrading.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'finops' },
  { id: 'U-3', accountId: 'GA-1001', loginId: 'TANJUNG-VIEWER', name: 'Budi Santoso', email: 'budi@tanjungtrading.example', roleId: 'role-viewer', status: 'active', mfaEnrolled: true },
  { id: 'U-4', accountId: 'GA-1001', loginId: 'TANJUNG-RAVI', name: 'Ravi Kumar', email: 'ravi@tanjungtrading.example', roleId: 'role-viewer', status: 'disabled' },
  { id: 'U-5', accountId: 'GA-2002', loginId: 'SERIMUTIARA-ADMIN', name: 'Nur Izzah', email: 'izzah@serimutiara.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-6', accountId: 'GA-3003', loginId: 'NUSAPANGAN-ADMIN', name: 'Dewi Lestari', email: 'dewi@nusapangan.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-7', accountId: 'GA-4004', loginId: 'LUMI-ADMIN', name: 'Nguyen Lan', email: 'lan@lumihome.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-8', accountId: 'GA-1001', loginId: 'TANJUNG-KEVIN', name: 'Kevin Ong', email: 'kevin@tanjungtrading.example', roleId: 'role-admin', status: 'active', demo: 'service-outage' },
  { id: 'U-10', accountId: 'GA-1001', loginId: 'TANJUNG-MERCHANT', name: 'Farah Ismail', email: 'farah.ismail@tanjungtrading.example', roleId: 'role-merchant', status: 'active', portal: 'merchant', merchantId: 'GM-100101' },
  { id: 'U-11', accountId: 'GA-4004', loginId: 'LUMI-MERCHANT', name: 'Lumi Finance', email: 'finance@lumihome.example', roleId: 'role-merchant', status: 'active', portal: 'merchant', merchantId: 'GM-100102', mfaEnrolled: true },
  { id: 'U-12', accountId: 'GA-1005', loginId: 'NUSANTARA-MERCHANT', name: 'Siti Aminah', email: 'siti@nusantarahome.example', roleId: 'role-merchant', status: 'active', portal: 'merchant', merchantId: 'GM-109001', mfaEnrolled: true },
  { id: 'U-9', accountId: 'GA-1001', loginId: 'TANJUNG-FARID', name: 'Farid Hassan', email: 'farid@tanjungtrading.example', roleId: 'role-admin', status: 'active', demo: 'otp-delivery-failure' },
  // One login per internal team (MFA already on), plus a prototype admin who can switch teams.
  { id: 'U-13', accountId: 'GA-1001', loginId: 'MOBI-RISK', name: 'Daniel Tan', email: 'daniel.tan@mobi.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'risk' },
  { id: 'U-14', accountId: 'GA-1001', loginId: 'MOBI-CS', name: 'Mei Ling Wong', email: 'meiling.wong@mobi.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'cs' },
  { id: 'U-15', accountId: 'GA-1001', loginId: 'MOBI-SUPPORT', name: 'Priya Nair', email: 'priya.nair@mobi.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'support' },
  { id: 'U-16', accountId: 'GA-1001', loginId: 'MOBI-SECURITY', name: 'Wei Jie Chen', email: 'weijie.chen@mobi.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'security' },
  { id: 'U-17', accountId: 'GA-1001', loginId: 'MOBI-ADMIN', name: 'Prototype Admin', email: 'prototype.admin@mobi.example', roleId: 'role-admin', status: 'active', mfaEnrolled: true, team: 'admin' },
];

/** Shown in the login screen's "sample accounts" panel. */
export const DEMO_ACCOUNT_GUIDE: { loginId: string; scenario: string; portal?: 'merchant' }[] = [
  { loginId: 'TANJUNG-MERCHANT', scenario: 'Tanjung Global Trading · 3 live countries · MFA not set up yet', portal: 'merchant' },
  { loginId: 'NUSANTARA-MERCHANT', scenario: 'Nusantara Home Retail · Malaysia & Indonesia live · MFA on', portal: 'merchant' },
  { loginId: 'LUMI-MERCHANT', scenario: 'Lumi Home Living · no live countries yet · MFA on', portal: 'merchant' },
  { loginId: '123', scenario: 'Sales / Operations · MFA not set up yet' },
  { loginId: 'MOBI-RISK', scenario: 'Risk · MFA on' },
  { loginId: 'MOBI-CS', scenario: 'Customer Success · MFA on' },
  { loginId: 'TANJUNG-ADMIN', scenario: 'FinOps · MFA on' },
  { loginId: 'MOBI-SUPPORT', scenario: 'Mobi Support · MFA on' },
  { loginId: 'MOBI-SECURITY', scenario: 'Security Admin (Tech) · MFA on' },
  { loginId: 'MOBI-ADMIN', scenario: 'Prototype admin · can switch teams with "View as" · MFA on' },
  { loginId: 'TANJUNG-VIEWER', scenario: 'Viewer (Sales / Operations) · MFA on' },
  { loginId: 'LUMI-ADMIN', scenario: 'Account with no active countries · MFA not set up yet' },
  { loginId: 'TANJUNG-RAVI', scenario: 'User access disabled' },
  { loginId: 'SERIMUTIARA-ADMIN', scenario: 'Account suspended' },
  { loginId: 'NUSAPANGAN-ADMIN', scenario: 'Account inactive' },
  { loginId: 'TANJUNG-KEVIN', scenario: 'Sign-in service unavailable' },
];

/** PROTOTYPE ONLY: the test accounts (with their registered email) that can sign in to one app. */
export function demoAccountsFor(portal: 'internal' | 'merchant'): { loginId: string; email: string; scenario: string }[] {
  return DEMO_ACCOUNT_GUIDE.filter((a) => (a.portal ?? 'internal') === portal).map((a) => ({
    loginId: a.loginId,
    email: SEED_USERS.find((u) => u.loginId === a.loginId)?.email ?? '',
    scenario: a.scenario,
  }));
}
