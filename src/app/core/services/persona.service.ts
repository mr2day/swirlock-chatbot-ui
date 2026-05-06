import { Injectable, computed, signal } from '@angular/core';
import type { Persona } from '../personas/persona.model';
import { DEFAULT_PERSONA_ID, PERSONAS, findPersona } from '../personas/personas.registry';

const STORAGE_KEY = 'gigi.activePersonaId';

/**
 * Tracks the active persona and applies its theme to the document root.
 *
 * The theme is a set of CSS custom properties (`--persona-*`) read by
 * `styles.scss` and every component. Switching personas is a single
 * write to `:root`, so the app re-skins instantly without a reload.
 *
 * Persona selection is persisted to `localStorage` so reloads remember
 * the last-active persona.
 */
@Injectable({ providedIn: 'root' })
export class PersonaService {
  private readonly _activeId = signal<string>(this.loadInitial());

  readonly all: readonly Persona[] = PERSONAS;
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed<Persona>(
    () => findPersona(this._activeId()) ?? PERSONAS[0],
  );

  constructor() {
    this.applyTheme(this.active());
  }

  setActive(id: string): void {
    if (!findPersona(id)) return;
    this._activeId.set(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable; ignore */
    }
    this.applyTheme(this.active());
  }

  private loadInitial(): string {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && findPersona(stored)) return stored;
    } catch {
      /* ignore */
    }
    return DEFAULT_PERSONA_ID;
  }

  private applyTheme(persona: Persona): void {
    const root = document.documentElement;
    const t = persona.theme;
    root.style.setProperty('--persona-bg', t.background);
    root.style.setProperty('--persona-surface', t.surface);
    root.style.setProperty('--persona-surface-elevated', t.surfaceElevated);
    root.style.setProperty('--persona-border', t.border);
    root.style.setProperty('--persona-text-primary', t.textPrimary);
    root.style.setProperty('--persona-text-secondary', t.textSecondary);
    root.style.setProperty('--persona-text-muted', t.textMuted);
    root.style.setProperty('--persona-accent', t.accent);
    root.style.setProperty('--persona-accent-contrast', t.accentContrast);
    root.style.setProperty('--persona-bubble-user', t.bubbleUser);
    root.style.setProperty('--persona-bubble-assistant', t.bubbleAssistant);
    root.style.setProperty('--persona-danger', t.danger);
  }
}
