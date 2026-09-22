/** Keep compact graph labels human-readable without hiding distinct identities. */
export function evidenceNodeLabel(text:string|null|undefined,kind:string,id:string) {
  if(text)return text;
  const words=kind.replace(/[_-]+/g,' ').trim()||'observation';
  const readable=words[0]!.toUpperCase()+words.slice(1);
  return readable+' · '+id.slice(0,8);
}
