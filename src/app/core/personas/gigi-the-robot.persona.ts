import type { Persona } from './persona.model';

/**
 * Gigi the Robot — the default and (today) only persona.
 *
 * The background color matches the dark slate of the persona's logo
 * artwork. If the logo is replaced later, also update `theme.background`
 * here so the chat surface and the logo stay in visual harmony.
 */
export const GIGI_THE_ROBOT: Persona = {
  id: 'gigi-the-robot',
  name: 'Gigi the Robot',
  shortDescription: 'Friendly robot buddy',
  logoUrl: 'personas/gigi-the-robot/logo.png',
  greeting: "Hi! I'm Gigi. Ask me anything.",
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
