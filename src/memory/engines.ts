import type {Settings} from '../config.js';
import type {MemoryEngine} from './engine.js';
import {HonchoEngine,honchoClient} from './honcho.js';

/** The one place that chooses the long-term memory engine. Honcho is the only engine today. */
export function memoryEngine(config:Pick<Settings,'honchoUrl'|'memoryToken'>):MemoryEngine {
  // Honcho checks keys signed with the memory token (ADR-0286): the main key for Nocheh's own calls, a wall key per read.
  return new HonchoEngine(honchoClient(config.honchoUrl,config.memoryToken),config.memoryToken);
}
