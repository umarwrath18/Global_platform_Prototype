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
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  {
    id: 'GA-1001',
    name: 'Tanjung Global Trading Sdn Bhd',
    status: 'active',
    countries: [
      { code: 'MY', status: 'active' },
      { code: 'ID', status: 'active' },
      { code: 'VN', status: 'active' },
      { code: 'TH', status: 'pending' },
      { code: 'PH', status: 'failed' },
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
  { id: 'U-1', accountId: 'GA-1001', loginId: '123', name: 'Sarah Lim', email: 'sarah.lim@tanjungtrading.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-2', accountId: 'GA-1001', loginId: 'MOBI-DEMO-ADMIN', name: 'Aisyah Rahman', email: 'aisyah@tanjungtrading.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-3', accountId: 'GA-1001', loginId: 'MOBI-DEMO-VIEWER', name: 'Budi Santoso', email: 'budi@tanjungtrading.example', roleId: 'role-viewer', status: 'active' },
  { id: 'U-4', accountId: 'GA-1001', loginId: 'MOBI-DEMO-DISABLED', name: 'Ravi Kumar', email: 'ravi@tanjungtrading.example', roleId: 'role-viewer', status: 'disabled' },
  { id: 'U-5', accountId: 'GA-2002', loginId: 'MOBI-DEMO-SUSPENDED', name: 'Nur Izzah', email: 'izzah@serimutiara.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-6', accountId: 'GA-3003', loginId: 'MOBI-DEMO-INACTIVE', name: 'Dewi Lestari', email: 'dewi@nusapangan.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-7', accountId: 'GA-4004', loginId: 'MOBI-DEMO-NOCOUNTRY', name: 'Nguyen Lan', email: 'lan@lumihome.example', roleId: 'role-admin', status: 'active' },
  { id: 'U-8', accountId: 'GA-1001', loginId: 'MOBI-DEMO-OUTAGE', name: 'Kevin Ong', email: 'kevin@tanjungtrading.example', roleId: 'role-admin', status: 'active', demo: 'service-outage' },
  { id: 'U-9', accountId: 'GA-1001', loginId: 'MOBI-DEMO-BOUNCE', name: 'Farid Hassan', email: 'farid@tanjungtrading.example', roleId: 'role-admin', status: 'active', demo: 'otp-delivery-failure' },
];

/** Shown in the login screen's "sample accounts" panel. */
export const DEMO_ACCOUNT_GUIDE: { loginId: string; scenario: string }[] = [
  { loginId: '123', scenario: 'Administrator · 3 active countries' },
  { loginId: 'MOBI-DEMO-ADMIN', scenario: 'Administrator · same account' },
  { loginId: 'MOBI-DEMO-VIEWER', scenario: 'Viewer · same account' },
  { loginId: 'MOBI-DEMO-NOCOUNTRY', scenario: 'Account with no active countries' },
  { loginId: 'MOBI-DEMO-DISABLED', scenario: 'User access disabled' },
  { loginId: 'MOBI-DEMO-SUSPENDED', scenario: 'Account suspended' },
  { loginId: 'MOBI-DEMO-INACTIVE', scenario: 'Account inactive' },
  { loginId: 'MOBI-DEMO-OUTAGE', scenario: 'Sign-in service unavailable' },
];
