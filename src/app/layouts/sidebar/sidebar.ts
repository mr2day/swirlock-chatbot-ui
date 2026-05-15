import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { LayoutService } from '../../core/services/layout.service';
import { SessionService } from '../../core/services/session.service';
import { AuthService } from '../../core/services/auth.service';
import { PersonaService } from '../../core/services/persona.service';
import { findPersona } from '../../core/personas/personas.registry';
import { PersonaSwitcher } from '../persona-switcher/persona-switcher';
import type { SessionSummary } from '../../core/models/chat-message.model';

interface SessionGroup {
  label: string;
  items: SessionSummary[];
}

const ONE_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * ONE_DAY;
const THIRTY_DAYS = 30 * ONE_DAY;

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, PersonaSwitcher],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  protected readonly session = inject(SessionService);
  protected readonly layout = inject(LayoutService);
  protected readonly auth = inject(AuthService);
  protected readonly persona = inject(PersonaService);
  private readonly router = inject(Router);

  /**
   * Resolves the small avatar shown next to a session row. Falls back
   * to the currently active persona's logo for legacy sessions that
   * predate the persona-scoping migration (`personaId === null`).
   */
  protected sessionLogo(personaId: string | null): string {
    const found = personaId ? findPersona(personaId) : undefined;
    return (found ?? this.persona.active()).logoUrl;
  }

  protected logout(): void {
    void this.auth.logout();
  }

  protected readonly groups = computed<SessionGroup[]>(() =>
    this.groupByRelativeDate(this.session.sessions()),
  );

  protected async newChat(): Promise<void> {
    try {
      const sessionId = await this.session.newSession();
      this.layout.closeSidebarOnMobileNav();
      await this.router.navigate(['/c', sessionId]);
    } catch {
      /* error already surfaced via SessionService.error */
    }
  }

  protected async deleteSession(
    event: MouseEvent,
    sessionId: string,
  ): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    try {
      await this.session.deleteSession(sessionId);
      if (this.session.sessions().length === 0) {
        await this.router.navigate(['/chat']);
      } else if (this.session.activeId() === null) {
        await this.router.navigate(['/chat']);
      }
    } catch {
      /* surfaced via SessionService.error */
    }
  }

  protected onSessionClick(sessionId: string): void {
    void this.session.openSession(sessionId);
    this.layout.closeSidebarOnMobileNav();
  }

  private groupByRelativeDate(list: readonly SessionSummary[]): SessionGroup[] {
    const now = Date.now();
    const buckets: Record<string, SessionSummary[]> = {
      Today: [],
      Yesterday: [],
      'Previous 7 days': [],
      'Previous 30 days': [],
      Older: [],
    };
    const sorted = [...list].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    for (const s of sorted) {
      const updated = Date.parse(s.updatedAt);
      if (Number.isNaN(updated)) {
        buckets['Older'].push(s);
        continue;
      }
      const age = now - updated;
      if (age < ONE_DAY) buckets['Today'].push(s);
      else if (age < 2 * ONE_DAY) buckets['Yesterday'].push(s);
      else if (age < SEVEN_DAYS) buckets['Previous 7 days'].push(s);
      else if (age < THIRTY_DAYS) buckets['Previous 30 days'].push(s);
      else buckets['Older'].push(s);
    }
    return Object.entries(buckets)
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => ({ label, items }));
  }
}
