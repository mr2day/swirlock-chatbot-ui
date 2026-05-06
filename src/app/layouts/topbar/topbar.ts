import { Component, inject } from '@angular/core';
import { LayoutService } from '../../core/services/layout.service';
import { PersonaService } from '../../core/services/persona.service';

@Component({
  selector: 'app-topbar',
  imports: [],
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  protected readonly layout = inject(LayoutService);
  protected readonly persona = inject(PersonaService);

  protected toggle(): void {
    this.layout.toggleSidebar();
  }
}
