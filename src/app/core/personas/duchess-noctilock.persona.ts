import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/** Duchess Noctilock — see shared-rules.agentBase for the body.
 *  Voice / lore / mannerisms stripped 2026-05-24. */
export const DUCHESS_NOCTILOCK: Persona = {
  id: 'duchess-noctilock',
  name: 'Duchess Noctilock',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/duchess-noctilock/logo.png',
  greeting: "Hi, I'm Duchess Noctilock. What do you need?",
  systemPromptTemplate: agentBase('Duchess Noctilock'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#a02942',
    accentContrast: '#f5f5f5',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
