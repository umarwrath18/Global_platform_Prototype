import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guards';
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
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Reset password · Mobi Global Platform',
    loadComponent: () => import('./features/auth/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    // Signed-in layout shared by the dashboard and Merchant Management.
    path: '',
    canActivate: [authGuard],
    canActivateChild: [authGuard],
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
        path: 'notifications',
        title: 'Notifications · Mobi Global Platform',
        loadComponent: () => import('./features/notifications/notifications').then((m) => m.Notifications),
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
