import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DemoAuthenticator } from '@gp/shared/demo-authenticator';
import { DemoInbox } from '@gp/shared/demo-inbox';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DemoInbox, DemoAuthenticator],
  template: `<router-outlet /><app-demo-inbox /><app-demo-authenticator />`,
})
export class App {}
