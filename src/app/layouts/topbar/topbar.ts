import { Component, inject } from '@angular/core';
import { LayoutService } from '../../core/services/layout.service';
import { AuthService } from '../../core/services/auth.service';
import { PersonaSwitcher } from '../persona-switcher/persona-switcher';

@Component({
  selector: 'app-topbar',
  imports: [PersonaSwitcher],
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  protected readonly layout = inject(LayoutService);
  protected readonly auth = inject(AuthService);

  protected toggle(): void {
    this.layout.toggleSidebar();
  }

  protected logout(): void {
    void this.auth.logout();
  }
}
