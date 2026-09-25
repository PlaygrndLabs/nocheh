import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {GuardedEditor} from '../guarded-editor.js';
import {SourceVersions} from './source-versions';
import {sourceContentLabel,sourceContentTypes} from '../../src/source-content.js';

function MediaPreview({file}){
 const [url,setUrl]=useState(null),[loading,setLoading]=useState(false),[problem,setProblem]=useState('');
 const pending=useRef(null),player=useRef(null);
 useEffect(()=>()=>pending.current?.abort(),[]);
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
 const kind=file.kind,media=kind==='voice'||kind==='audio'?'audio':kind==='video'||kind==='video_note'?'video':kind==='photo'||kind==='image'?'image':null;
 useEffect(()=>{
  if(media!=='audio'||!url||!player.current)return;
  player.current.play().catch(error=>setProblem(error?.name==='NotAllowedError'?'Use the audio controls to start playback.':'Audio preview could not play. Download the original file instead.'));
 },[media,url]);
 if(!media||file.state!=='ready')return null;
 const fallback={voice:'audio/ogg',audio:'audio/mpeg',video:'video/mp4',video_note:'video/mp4',photo:'image/jpeg',image:'image/jpeg'}[kind];
 const supplied=file.metadata?.mime_type;
 const safeTypes={audio:['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm'],video:['video/mp4','video/webm','video/ogg'],image:['image/jpeg','image/png','image/webp','image/gif']};
 const mime=safeTypes[media].includes(supplied)?supplied:fallback;
 async function load(){
  const controller=new AbortController();pending.current=controller;setLoading(true);setProblem('');
  try{
   const response=await fetch(base+'/artifacts/'+file.id+'/download',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(!response.ok)throw Error('preview_unavailable');
   const bytes=await response.arrayBuffer();
   if(!controller.signal.aborted)setUrl(URL.createObjectURL(new Blob([bytes],{type:mime})));
  }catch{if(!controller.signal.aborted)setProblem('Preview unavailable. Download the original file instead.');}
  finally{if(!controller.signal.aborted){pending.current=null;setLoading(false);}}
 }
 return h('div',{className:'source-media-preview'},
  !url&&h('button',{type:'button',onClick:load,disabled:loading},loading?'Loading preview…':media==='image'?'View image':'Play '+sourceContentLabel(kind).toLowerCase()),
  url&&media==='audio'&&h('audio',{ref:player,controls:true,preload:'auto',src:url,'aria-label':sourceContentLabel(kind)}),
  url&&media==='video'&&h('video',{controls:true,preload:'none',src:url,'aria-label':sourceContentLabel(kind)}),
  url&&media==='image'&&h('img',{src:url,alt:'Original '+sourceContentLabel(kind).toLowerCase()}),
  problem&&h('p',{role:'status'},problem));
}

export function Source({record,notify}){
 const files=record.artifacts||[],generated=record.derived||[];
 const transcripts=generated.filter(item=>item.kind==='transcript'),otherGenerated=generated.filter(item=>item.kind!=='transcript');
 const originalText=record.event?.text,types=sourceContentTypes(record.event?.kind,record.event?.payload,files.map(file=>file.kind));
 const hasSpeech=types.some(type=>type==='voice'||type==='audio'||type==='video_note');
 const payload=record.event?.payload||{},message=payload.message||payload.edited_message||payload.channel_post||payload.edited_channel_post||{};
 const structured=message.contact?[message.contact.first_name,message.contact.last_name,message.contact.phone_number].filter(Boolean).join(' · '):
  message.venue?[message.venue.title,message.venue.address].filter(Boolean).join(' · '):
  message.location?[message.location.latitude,message.location.longitude].filter(value=>value!==undefined).join(', '):
  message.poll?message.poll.question:message.dice?[message.dice.emoji,message.dice.value].join(' · '):message.game?.title||null;
 const original=h('section',{className:'n-panel n-original-evidence'},
  h('div',{className:'source-section-heading'},h('div',null,h('p',{className:'archive-kicker'},'Original message'),h('h2',null,'What was received')),h(Badge,null,'Permanent · read only')),
  h('p',{className:'n-muted'},'This is the source of truth and cannot be edited.'),
  types.length>0&&originalText?.trim()&&h('div',{className:'source-content-types','aria-label':'Message content'},...types.map(type=>h('span',{className:'source-content-type',key:type},sourceContentLabel(type)))),
  originalText?.trim()?h('div',{className:'n-original-message',dir:'auto'},originalText):
   h('div',{className:'n-original-message source-no-text'},types.length?types.map(sourceContentLabel).join(' · '):'Message without text',
    structured&&h('small',{dir:'auto'},structured),
    files.length>0&&h('small',null,'The original attachment is below.')),
  files.length>0&&h('section',{className:'source-files'},h('h3',null,files.length===1?'Original attachment':'Original attachments'),...files.map(file=>{
   const name=file.metadata?.relative_path?.split('/').pop()||file.metadata?.file_name;
   const duration=Number(file.metadata?.duration);
   return h('div',{className:'source-file',key:file.id},h('div',{className:'source-file-main'},h('strong',null,sourceContentLabel(file.kind)),name&&h('span',{dir:'auto'},name),Number.isFinite(duration)&&duration>0&&h('small',null,Math.floor(duration/60)+':'+String(Math.floor(duration%60)).padStart(2,'0'))),
    h('div',{className:'source-file-actions'},h(StatusBadge,{state:file.state}),button('Download original',()=>download('/artifacts/'+file.id+'/download',name||file.id,notify),file.state!=='ready')),
    h(MediaPreview,{file}));})),
  h('details',{className:'source-technical'},h('summary',null,'Advanced details and export'),
    h('p',{className:'n-muted'},'Generated items, provenance, source identity, and the complete source export.'),
    otherGenerated.length>0&&h('section',{className:'source-generated'},h('h3',null,otherGenerated.length+' generated '+(otherGenerated.length===1?'item':'items')),...otherGenerated.map(item=>h('article',{key:item.id},h(Badge,null,'Generated'),h('h3',null,item.kind==='browser_result'?'Assistant result':'Generated '+item.kind.replaceAll('_',' ')),h(Data,{value:new TextDecoder().decode(Uint8Array.from(atob(item.content_base64),character=>character.charCodeAt(0)))}),h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:item.provenance}))))),
    h('details',null,h('summary',null,'Source identity and technical metadata'),h(Data,{value:record})),
    h('div',{className:'source-utility-actions'},button('Download source JSON',()=>exportJSON({id:record.id,reference:record.reference,event:record.event,artifacts:files},'nocheh-source-'+record.id+'.json')))));
 return h('div',{className:'source-stack'},
  original,
  record.derivative_versions&&record.event?.channel==='telegram'&&!!(payload.message||payload.edited_message||payload.channel_post||payload.edited_channel_post)&&
   h(SourceRetirement,{key:record.id,eventId:record.id,notify}),
  (hasSpeech||transcripts.length>0)&&h('section',{className:'n-panel source-transcript'},
   h('div',{className:'source-section-heading'},h('div',null,h('p',{className:'archive-kicker'},'Generated from audio'),h('h2',null,'Transcript')),h(Badge,null,transcripts.length?'Active version':'Unavailable')),
   transcripts.length?transcripts.map(item=>h('div',{key:item.id},transcripts.length>1&&h('h3',null,files.find(file=>file.id===item.artifact_id)?.metadata?.file_name||'Audio attachment'),h('p',{className:'source-transcript-text',dir:'auto'},new TextDecoder().decode(Uint8Array.from(atob(item.content_base64),character=>character.charCodeAt(0)))||'The active transcript is empty.'),h('details',{className:'source-transcript-provenance'},h('summary',null,'Transcription provenance'),h(Data,{value:item.provenance})))):
    h('p',{className:'n-muted source-transcript-empty'},'No active transcript is available for this message.')),
  !record.derivative_versions&&h(GuardedEditor,{key:record.id,record,call,notify}),
  record.derivative_versions&&h(SourceVersions,{key:record.id,record}));
}

function SourceRetirement({eventId,notify}){
 const path='/sources/'+eventId+'/retirement',resource=useResource(path);
 const [saved,setSaved]=useState(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const state=saved&&(!resource.data||saved.revision>resource.data.revision)?saved:resource.data;
 async function change(){
  if(!state||busy)return;
  setBusy(true);setProblem('');
  try{
   const result=await call(path,{retired:!state.retired,expected_revision:state.revision,operation_id:crypto.randomUUID()});
   setSaved({...state,...result});
   notify(result.retired?'Message retired from future use.':'Message restored for future use.');
   void refreshResources();
  }catch(error){setProblem(errorText(error));void refreshResources();}finally{setBusy(false);}
 }
 if(resource.error?.includes('telegram_message_not_found'))return null;
 return h('section',{className:'n-panel source-retirement','aria-label':'Nocheh use of this message'},
  h('p',{className:'archive-kicker'},'Nocheh use'),
  h('h2',null,'Use of this message'),
  h('div',{className:'source-retirement-state','data-retired':state?.retired?'true':'false',role:'status','aria-live':'polite'},
   h('strong',null,!state?'Checking status…':state.retired?'Retired from Nocheh':'Available to Nocheh'),
   h('span',null,!state?'Loading the saved owner decision.':state.retired?'Nocheh will not use this message or its edits in future replies or learning.':'Nocheh may use this message and its edits in future replies or learning.')),
  h('p',{className:'n-muted source-retirement-note'},'The original stays in Archive. Retirement does not delete a Telegram message or recall a reply already sent.'),
  resource.error&&!state&&h(Alert,null,'Retirement status is unavailable. Refresh and try again.'),
  problem&&h('p',{className:'source-retirement-error',role:'alert'},'Change was not saved: '+problem+'. Check the current status and try again.'),
  state&&button(busy?state.retired?'Restoring…':'Retiring…':state.retired?'Undo retirement':'Retire this message',change,busy,state.retired?'':'n-primary'),
  state?.history?.length>0&&h('details',null,h('summary',null,'Owner action history'),h(Data,{value:state.history})));
}
