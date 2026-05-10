/**
 * A persona is *both* a UI skin and an LLM personality. Both definitions
 * live here, in the UI: `theme` controls the CSS custom properties on
 * `:root`, and `systemPromptTemplate` is the LLM system prompt that the
 * UI sends to the orchestrator on session creation. The orchestrator
 * does not own any persona definition — it just stores the resolved
 * prompt on the session and pipes it to the model.
 *
 * `systemPromptTemplate` may contain a literal `${model}` placeholder,
 * which the UI substitutes with the LLM model id reported by the
 * orchestrator before sending. No other interpolation is performed.
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
  /** Stable id used by the UI for theme switching and storage keys. */
  id: string;
  /** Display name surfaced everywhere ("Gigi the Robot"). */
  name: string;
  /** Short blurb shown next to the avatar. */
  shortDescription: string;
  /** Path under `public/` for the persona's logo image. */
  logoUrl: string;
  /** One-line greeting hint shown on the empty-state screen. */
  greeting: string;
  /** UI skin applied to CSS custom properties on the document root. */
  theme: PersonaTheme;
  /**
   * The LLM system prompt for this persona. May contain a literal
   * `${model}` placeholder, which the UI substitutes with the model id
   * reported by the orchestrator before sending on session.create.
   */
  systemPromptTemplate: string;
}
