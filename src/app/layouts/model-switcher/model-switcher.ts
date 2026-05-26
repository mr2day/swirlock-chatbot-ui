import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { BackendService } from '../../core/services/backend.service';
import type { BackendName } from '../../core/services/backend.service';

/**
 * Backend (model) switcher. Renders the agent's `backends.list`
 * dropdown; clicking a backend round-trips through the agent's
 * `session.set_backend` and only updates the displayed selection
 * once the agent confirms (BackendService.select awaits the reply,
 * and selectedName re-derives from the active session's
 * defaultBackend).
 *
 * The dropdown is hidden (label renders as a static span) when only
 * one backend is available or there is no active session yet.
 */
@Component({
  selector: 'app-model-switcher',
  imports: [],
  templateUrl: './model-switcher.html',
  styleUrl: './model-switcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelSwitcher {
  protected readonly backend = inject(BackendService);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly open = signal(false);

  protected readonly hasChoice = computed(
    () => this.backend.backends().length > 1,
  );

  protected toggle(): void {
    if (!this.hasChoice()) return;
    if (this.backend.switching()) return;
    this.open.update((v) => !v);
  }

  protected async select(name: BackendName): Promise<void> {
    this.open.set(false);
    try {
      await this.backend.select(name);
    } catch {
      // Failures (no active session, agent error) are silent here;
      // the dropdown closes and selectedName stays on the prior value.
      // A future iteration can surface a toast.
    }
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    const target = event.target as Node | null;
    if (target && !this.host.nativeElement.contains(target)) {
      this.open.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.open.set(false);
  }
}
