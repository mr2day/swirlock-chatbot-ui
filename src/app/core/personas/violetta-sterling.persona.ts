import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/** Violetta Sterling — see shared-rules.agentBase for the body.
 *  Voice / lore / mannerisms stripped 2026-05-24. */
export const VIOLETTA_STERLING: Persona = {
  id: 'violetta-sterling',
  name: 'Violetta Sterling',
  gender: 'female',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/violetta-sterling/logo.png',
  greeting: "Hi, I'm Violetta Sterling. How can I be of help?",
  systemPromptTemplate: agentBase('Violetta Sterling', 'female'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#7b4a9a',
    accentContrast: '#f5f5f5',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
