import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/**
 * Gigi the Robot. After 2026-05-24 every persona uses the same
 * agent body (see shared-rules.agentBase); the 6 personas differ
 * only by name, avatar, and theme. Voice / lore / mannerisms are
 * deliberately gone — users reported metaphor-heavy responses and
 * hallucinated lore-references that came from the prior
 * character-driven templates.
 */
export const GIGI_THE_ROBOT: Persona = {
  id: 'gigi-the-robot',
  name: 'Gigi the Robot',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/gigi-the-robot/logo.png',
  greeting: "Hi, I'm Gigi. What do you need?",
  systemPromptTemplate: agentBase('Gigi the Robot'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#f5b916',
    accentContrast: '#1a1a1b',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
