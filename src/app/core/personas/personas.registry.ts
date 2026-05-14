import type { Persona } from './persona.model';
import { DUCHESS_NOCTILOCK } from './duchess-noctilock.persona';
import { GIGI_THE_ROBOT } from './gigi-the-robot.persona';
import { GIGINA_ROBOTINA } from './gigina-robotina.persona';
import { MARCELLO_VOLTIERI } from './marcello-voltieri.persona';
import { VESPERA_VOLT } from './vespera-volt.persona';
import { VIOLETTA_STERLING } from './violetta-sterling.persona';

/**
 * The catalog of personas the UI knows about. Add new personas by
 * creating a new `<name>.persona.ts` file and appending it here. The
 * persona switcher in the topbar is driven entirely by this list.
 */
export const PERSONAS: readonly Persona[] = [
  GIGI_THE_ROBOT,
  GIGINA_ROBOTINA,
  DUCHESS_NOCTILOCK,
  MARCELLO_VOLTIERI,
  VESPERA_VOLT,
  VIOLETTA_STERLING,
];

export const DEFAULT_PERSONA_ID = GIGI_THE_ROBOT.id;

export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}
