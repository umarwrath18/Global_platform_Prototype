import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DemoInbox } from './shared/demo-inbox';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DemoInbox],
  template: `<router-outlet /><app-demo-inbox />`,
})
export class App {}
