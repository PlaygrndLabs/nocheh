import type {Settings} from '../config.js';
import type {MemoryEngine} from './engine.js';
import {HonchoEngine,honchoClient} from './honcho.js';

/** The one place that chooses the long-term memory engine. Honcho is the only engine today. */
export function memoryEngine(config:Pick<Settings,'honchoUrl'>):MemoryEngine {
  return new HonchoEngine(honchoClient(config.honchoUrl));
}
