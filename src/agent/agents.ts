import type {Settings} from '../config.js';
import type {Agent} from './agent.js';
import {hermesAgent} from './hermes.js';

/** The agent that runs. Turn passes name it (ADR-0233); one agent runs at a time, and Hermes is the only agent today. */
export const activeAgent='hermes';
/** The one place that chooses the agent (ADR-0234). */
export function agent(config:Pick<Settings,'hermesUrl'|'token'>):Agent {
  const plugged=hermesAgent({url:config.hermesUrl,token:config.token});
  if(plugged.id!==activeAgent)throw new Error('agent_id_mismatch');
  return plugged;
}
