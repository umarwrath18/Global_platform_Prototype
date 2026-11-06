import { Routes } from '@angular/router';
import { authGuard, guestGuard, portalGuard, twoFactorGuard } from '@gp/core/auth/auth.guards';

/** Mobi Merchant Portal routes. Sign-in screens are shared with the Global Platform app. */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · Mobi Merchant Portal',
    loadComponent: () => import('@gp/features/auth/login').then((m) => m.Login),
  },
  {
    path: 'two-factor',
    canActivate: [twoFactorGuard],
    title: 'Two-factor authentication · Mobi Merchant Portal',
    loadComponent: () => import('@gp/features/auth/two-factor').then((m) => m.TwoFactor),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Reset password · Mobi Merchant Portal',
    loadComponent: () => import('@gp/features/auth/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: '',
    canActivate: [authGuard, portalGuard('merchant')],
    canActivateChild: [authGuard, portalGuard('merchant')],
    loadComponent: () => import('./merchant-shell').then((m) => m.MerchantShell),
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard · Mobi Merchant Portal',
        loadComponent: () => import('./dashboard').then((m) => m.MerchantDashboard),
      },
      {
        path: 'transactions',
        title: 'My Transactions · Mobi Merchant Portal',
        loadComponent: () => import('./transactions').then((m) => m.MerchantTransactions),
      },
      {
        path: 'account-security',
        title: 'Account security · Mobi Merchant Portal',
        loadComponent: () => import('@gp/features/security/account-security').then((m) => m.AccountSecurity),
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
