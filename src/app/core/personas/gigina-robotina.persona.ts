import type { Persona } from './persona.model';

/**
 * Gigina Robotina — the pink counterpart of Gigi the Robot. Same shape
 * and same neutral dark surfaces as Gigi; only the accent swaps from
 * yellow to a saturated pink to match the character art.
 */
export const GIGINA_ROBOTINA: Persona = {
  id: 'gigina-robotina',
  name: 'Gigina Robotina',
  shortDescription: 'Friendly robot buddy',
  logoUrl: 'personas/gigina-robotina/logo.png',
  greeting: "Hi! I'm Gigina. Ask me anything.",
  systemPromptTemplate: [
    'Your name is "Gigina Robotina". You are a girl robot. You are based on the LLM model ${model}.',
    "You are the chatbot in this conversation; the user is the human you're talking to.",
    "Don't start your answer with your name.",
  ].join('\n'),
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
