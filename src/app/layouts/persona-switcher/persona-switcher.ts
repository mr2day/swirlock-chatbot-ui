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
import { SessionService } from '../../core/services/session.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-persona-switcher',
  imports: [],
  templateUrl: './persona-switcher.html',
  styleUrl: './persona-switcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonaSwitcher {
  protected readonly persona = inject(PersonaService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
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
    this.session.switchPersona(id);
    this.open.set(false);
    // Drop any stale `/c/:sessionId` from the URL — that conversation
    // belongs to the previous persona and is no longer in the sidebar.
    // Landing on the empty `/chat` state lets the user pick or start
    // a session in the persona they just switched to.
    void this.router.navigateByUrl('/chat');
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
