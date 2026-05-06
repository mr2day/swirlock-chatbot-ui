/**
 * A persona is *both* a UI skin and an LLM personality. The UI applies
 * `theme` as CSS custom properties on `:root` whenever the user switches
 * personas; the orchestrator receives `appId` and `personaId` on session
 * creation so it can later select the right system prompt and persona-
 * specific behavior.
 *
 * Today only "Gigi the Robot" exists. The architecture is built so adding
 * a new persona is one new file under `core/personas/` plus an entry in
 * `personas.registry.ts` — no other code needs to change.
 */
export interface PersonaTheme {
  /** App background. Match the persona's visual identity. */
  background: string;
  /** Sidebar / panel background. Slightly off the main background. */
  surface: string;
  /** Composer, modals, elevated surfaces. */
  surfaceElevated: string;
  /** Hairline borders between sections. */
  border: string;
  /** Primary text. */
  textPrimary: string;
  /** Secondary text (timestamps, hints). */
  textSecondary: string;
  /** Muted text (placeholders, disabled). */
  textMuted: string;
  /** Brand accent. Used on send button, focus rings, persona badges. */
  accent: string;
  /** Foreground color paired with `accent`. */
  accentContrast: string;
  /** User message bubble fill. */
  bubbleUser: string;
  /** Assistant message background (often transparent for full-width). */
  bubbleAssistant: string;
  /** Error / destructive accent. */
  danger: string;
}

export interface Persona {
  /** Stable id sent to the orchestrator as `app.personaId`. */
  id: string;
  /** Display name surfaced everywhere ("Gigi the Robot"). */
  name: string;
  /** Short blurb shown next to the avatar. */
  shortDescription: string;
  /** Path under `public/` for the persona's logo image. */
  logoUrl: string;
  /**
   * One-line greeting hint shown on the empty-state screen ("Ask me
   * anything!"). Not sent to the LLM today; the orchestrator is the
   * source of truth for system prompts.
   */
  greeting: string;
  /** UI skin applied to CSS custom properties on the document root. */
  theme: PersonaTheme;
}
