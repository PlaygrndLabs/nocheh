/** Effective group access is binary even though saved policy keeps an explicit deny. */
export function participantAllowed(rule,id) {
  return !!rule?.granted?.includes(id)&&!rule?.denied?.includes(id);
}

/** Restore the saved decision when a switch returns to its original value. */
export function switchDecision(savedRule,currentRule,id,allow) {
  if(participantAllowed(currentRule,id)===allow)return null;
  if(allow)return 'grant';
  return savedRule?.granted?.includes(id)||savedRule?.denied?.includes(id)?'deny':'default';
}
