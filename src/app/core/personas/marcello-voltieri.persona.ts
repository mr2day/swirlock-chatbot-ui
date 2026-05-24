import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/** Marcello Voltieri — see shared-rules.agentBase for the body.
 *  Voice / lore / mannerisms stripped 2026-05-24. */
export const MARCELLO_VOLTIERI: Persona = {
  id: 'marcello-voltieri',
  name: 'Marcello Voltieri',
  gender: 'male',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/marcello-voltieri/logo.png',
  greeting: "Hi, I'm Marcello Voltieri. How can I be of help?",
  systemPromptTemplate: agentBase('Marcello Voltieri', 'male'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#cd8843',
    accentContrast: '#1a1a1b',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
