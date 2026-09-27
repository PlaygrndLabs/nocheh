import {useCallback,useState,type Dispatch,type SetStateAction} from 'react';
/** Bind edits to the revision they began on; background refresh must not rebase them. */
export function useRevisionDraft<T extends Record<string,unknown>>(revision:string|number|undefined):[T,Dispatch<SetStateAction<T>>,string|number|undefined]{
 const [draft,setDraft]=useState<{changes:T;revision:string|number|undefined}>({changes:{} as T,revision:undefined});
 const change=useCallback<Dispatch<SetStateAction<T>>>(value=>setDraft(previous=>{const changes=typeof value==='function'?value(previous.changes):value;return {changes,revision:Object.keys(changes).length?(previous.revision??revision):undefined};}),[revision]);
 return [draft.changes,change,draft.revision??revision];
}
