import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { PersonaService } from '../../core/services/persona.service';

@Component({
  selector: 'app-persona-switcher',
  imports: [],
  templateUrl: './persona-switcher.html',
  styleUrl: './persona-switcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonaSwitcher {
  protected readonly persona = inject(PersonaService);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** When true, the trigger shows the short description under the name. */
  readonly showTagline = input(false);

  /**
   * When true, the trigger renders as a large title-sized persona name
   * with a chevron and no logo — meant for the hero on the landing page
   * where the persona name is also the page heading.
   */
  readonly asTitle = input(false);

  protected readonly open = signal(false);

  protected readonly others = computed(() =>
    this.persona.all.filter((p) => p.id !== this.persona.activeId()),
  );

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected select(id: string): void {
    this.persona.setActive(id);
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
