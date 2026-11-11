import type {Settings} from '../config.js';
import type {Brain} from './brain.js';
import {hermesBrain} from './hermes.js';

/** The brain that runs. Turn passes name it (ADR-0233); one brain runs at a time, and Hermes is the only brain today. */
export const activeBrain='hermes';
/** The one place that chooses the brain (ADR-0234). */
export function brain(config:Pick<Settings,'hermesUrl'|'token'>):Brain {
  const plugged=hermesBrain({url:config.hermesUrl,token:config.token});
  if(plugged.id!==activeBrain)throw new Error('brain_id_mismatch');
  return plugged;
}
