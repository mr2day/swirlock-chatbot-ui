import type { Persona } from './persona.model';
import { GIGI_THE_ROBOT } from './gigi-the-robot.persona';

/**
 * The catalog of personas the UI knows about. Add new personas by
 * creating a new `<name>.persona.ts` file and appending it here. The
 * persona switcher in the topbar is driven entirely by this list.
 *
 * Future planned entries (placeholders, not yet implemented):
 *   - Gigina Robotina
 *   - The English Teacher
 *   - The Italian Actor
 */
export const PERSONAS: readonly Persona[] = [GIGI_THE_ROBOT];

export const DEFAULT_PERSONA_ID = GIGI_THE_ROBOT.id;

export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}
