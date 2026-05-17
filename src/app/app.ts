import { Component, effect, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterOutlet } from '@angular/router';
import { NativeLifecycleService } from './core/services/native-lifecycle.service';
import { PersonaService } from './core/services/persona.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly persona = inject(PersonaService);
  private readonly titleSvc = inject(Title);
  private readonly nativeLifecycle = inject(NativeLifecycleService);

  constructor() {
    // Keep the browser tab title in sync with the active persona name so
    // adding new personas later just works without touching this code.
    effect(() => {
      this.titleSvc.setTitle(this.persona.active().name);
    });

    // Wire Android back-button + pull-to-refresh on Capacitor; no-op
    // on the web build.
    this.nativeLifecycle.initIfNative();
  }
}
