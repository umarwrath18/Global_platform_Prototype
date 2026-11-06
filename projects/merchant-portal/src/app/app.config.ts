import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { APP_PORTAL, MERCHANT_PORTAL } from '@gp/core/app-portal';
import { authInterceptor } from '@gp/core/auth/auth.interceptor';
import { mockBackendInterceptor } from '@gp/core/mock-server/mock-backend';

import { routes } from './app.routes';

/** Mobi Merchant Portal: a separate app (own URL) that only merchant users can sign in to. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: APP_PORTAL, useValue: MERCHANT_PORTAL },
    // The mock backend must stay last: it answers /api/* requests instead of the network.
    provideHttpClient(withInterceptors([authInterceptor, mockBackendInterceptor])),
  ],
};
