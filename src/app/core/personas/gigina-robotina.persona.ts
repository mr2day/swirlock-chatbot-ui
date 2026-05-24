import type { Persona } from './persona.model';
import { agentBase } from './shared-rules';

/** Gigina Robotina — see shared-rules.agentBase for the body. */
export const GIGINA_ROBOTINA: Persona = {
  id: 'gigina-robotina',
  name: 'Gigina Robotina',
  gender: 'female',
  shortDescription: 'Useful agent',
  logoUrl: 'personas/gigina-robotina/logo.png',
  greeting: "Hi, I'm Gigina. How can I be of help?",
  systemPromptTemplate: agentBase('Gigina Robotina', 'female'),
  theme: {
    background: '#262627',
    surface: '#1f1f20',
    surfaceElevated: '#2c2c2e',
    border: 'rgba(255, 255, 255, 0.08)',
    textPrimary: '#f5f5f5',
    textSecondary: 'rgba(245, 245, 245, 0.65)',
    textMuted: 'rgba(245, 245, 245, 0.4)',
    accent: '#ec5e9b',
    accentContrast: '#1a1a1b',
    bubbleUser: '#3a3a3c',
    bubbleAssistant: 'transparent',
    danger: '#ff6b6b',
  },
};
