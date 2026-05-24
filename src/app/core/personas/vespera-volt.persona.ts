import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/** Vespera Volt — see shared-rules.agentBase for the body.
 *  Voice / lore / mannerisms stripped 2026-05-24. */
export const VESPERA_VOLT: Persona = {
  id: 'vespera-volt',
  name: 'Vespera Volt',
  gender: 'female',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/vespera-volt/logo.png',
  greeting: "Hi, I'm Vespera Volt. How can I be of help?",
  systemPromptTemplate: agentBase('Vespera Volt', 'female'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#9d6dff',
    accentContrast: '#1a1a1b',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
