import { Routes } from '@angular/router';
import { authGuard, guestGuard, portalGuard, twoFactorGuard } from './core/auth/auth.guards';
import { unsavedChangesGuard } from './features/applications/unsaved-changes.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · Mobi Global Platform',
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'mfa',
    canActivate: [twoFactorGuard],
    title: 'MFA · Mobi Global Platform',
    loadComponent: () => import('./features/auth/two-factor').then((m) => m.TwoFactor),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Reset password · Mobi Global Platform',
    loadComponent: () => import('./features/auth/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    // Signed-in layout shared by the dashboard and Merchant Management (internal users only; merchant users use the separate Mobi Merchant Portal app).
    path: '',
    canActivate: [authGuard, portalGuard('internal')],
    canActivateChild: [authGuard, portalGuard('internal')],
    loadComponent: () => import('./shared/portal-shell').then((m) => m.PortalShell),
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard · Mobi Global Platform',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'dashboard/:country',
        title: 'Dashboard · Mobi Global Platform',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'merchants',
        title: 'Merchants · Mobi Global Platform',
        loadComponent: () => import('./features/merchants/merchant-list').then((m) => m.MerchantList),
      },
      {
        path: 'merchants/new',
        title: 'Add new merchant · Mobi Global Platform',
        loadComponent: () => import('./features/merchants/new-merchant').then((m) => m.NewMerchant),
      },
      {
        path: 'merchants/expand',
        title: 'Add country to existing merchant · Mobi Global Platform',
        loadComponent: () => import('./features/merchants/add-country').then((m) => m.AddCountry),
      },
      {
        path: 'merchants/:id',
        title: 'Merchant · Mobi Global Platform',
        loadComponent: () => import('./features/merchants/merchant-detail').then((m) => m.MerchantDetailPage),
      },
      {
        path: 'applications',
        title: 'Applications · Mobi Global Platform',
        loadComponent: () => import('./features/applications/application-list').then((m) => m.ApplicationList),
      },
      {
        path: 'applications/:id',
        title: 'Country application · Mobi Global Platform',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./features/applications/application-page').then((m) => m.ApplicationPage),
      },
      {
        path: 'applications/:id/products',
        title: 'Products & pricing · Mobi Global Platform',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./features/products/products-page').then((m) => m.ProductsPage),
      },
      {
        path: 'approvals',
        title: 'Approvals · Mobi Global Platform',
        loadComponent: () => import('./features/approvals/approvals').then((m) => m.Approvals),
      },
      {
        path: 'pricing-approvals',
        title: 'Pricing Approvals · Mobi Global Platform',
        loadComponent: () => import('./features/pricing/pricing-approvals').then((m) => m.PricingApprovals),
      },
      {
        path: 'pricing-audit',
        title: 'MDR audit log · Mobi Global Platform',
        loadComponent: () => import('./features/pricing/pricing-audit').then((m) => m.PricingAudit),
      },
      {
        path: 'configuration/mcc',
        title: 'MCC catalogue · Mobi Global Platform',
        loadComponent: () => import('./features/configuration/mcc-catalogue').then((m) => m.MccCataloguePage),
      },
      {
        path: 'account/security',
        title: 'Account security · Mobi Global Platform',
        loadComponent: () => import('./features/security/account-security').then((m) => m.AccountSecurity),
      },
      {
        path: 'security/users',
        title: 'User security · Mobi Global Platform',
        loadComponent: () => import('./features/security/user-security').then((m) => m.UserSecurity),
      },
      {
        path: 'notifications',
        title: 'Notifications · Mobi Global Platform',
        loadComponent: () => import('./features/notifications/notifications').then((m) => m.Notifications),
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
