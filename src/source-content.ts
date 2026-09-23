/** A display hint derived from original evidence; never a transcript or interpretation. */
export const contentLabels:Record<string,string>={
 voice:'Voice message',audio:'Audio',video_note:'Video message',video:'Video',photo:'Photo',
 document:'Document',sticker:'Sticker',animation:'Animation',file:'File',image:'Image',
 contact:'Contact',location:'Location',venue:'Venue',poll:'Poll',dice:'Dice',
 game:'Game',story:'Story',paid_media:'Paid media',invoice:'Invoice',
};

export function sourceContentTypes(kind:string,payload:unknown,artifactKinds:string[]=[]):string[] {
 const types=new Set<string>();
 const value=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
 const message=['message','edited_message','channel_post','edited_channel_post'].map(key=>value[key])
  .find(item=>item&&typeof item==='object'&&!Array.isArray(item)) as Record<string,unknown>|undefined;
 const body=message??value;
 for(const key of Object.keys(contentLabels))if(body[key]!=null)types.add(key);
 for(const key of artifactKinds)types.add(key in contentLabels?key:'file');
 if(kind==='telegram_update'&&!types.size&&body?.message_id==null&&value.message_reaction!=null)types.add('reaction');
 return [...types];
}

export function sourceContentLabel(type:string):string {
 return contentLabels[type]??(type==='reaction'?'Reaction':'Attachment');
}
