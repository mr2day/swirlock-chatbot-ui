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
 * Inline backend (model) switcher rendered under the assistant's name
 * inside each assistant message bubble. Mirrors `app-persona-switcher`
 * visually — a small label with a down-chevron that opens a dropdown
 * of the LLM backends the host has been configured to serve.
 *
 * Selection is persisted per-user in localStorage and applies to every
 * subsequent turn. The dropdown is hidden (the label renders as a
 * plain `<span>`) when only one backend is available, so users on
 * Ollama-only deployments see no UI change.
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
    this.open.update((v) => !v);
  }

  protected select(name: BackendName): void {
    this.backend.select(name);
    this.open.set(false);
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
