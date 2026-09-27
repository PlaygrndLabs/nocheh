import {useEffect,useState} from 'react';
import {BookOpen,BrainCircuit,Database,Network} from 'lucide-react';
import {Tabs,TabsContent,TabsList,TabsTrigger} from '../components/ui/primitives';
import {Memory} from './memory';
import {LearnedMemory} from './learned';
import {Honcho} from './honcho.js';
import {MemoryMap} from './memory-map';

type MemoryView='working'|'learned'|'honcho'|'relations';
const views:MemoryView[]=['working','learned','honcho','relations'];
const legacyViews:Record<string,MemoryView>={learned:'learned',entities:'relations',memoryMap:'relations',honcho:'honcho'};

function currentView():MemoryView{
 const [route,search='']=location.hash.slice(1).split('?'),requested=new URLSearchParams(search).get('view');
 return views.includes(requested as MemoryView)?requested as MemoryView:legacyViews[route]??'working';
}

export function MemoryWorkspace({notify}:{notify:(text:string,error?:boolean)=>void}){
 const [view,setView]=useState<MemoryView>(currentView);
 useEffect(()=>{const changed=()=>setView(currentView());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
 const select=(next:string)=>{const value=next as MemoryView;setView(value);location.hash='memory?view='+value;};
 return <Tabs value={view} onValueChange={select} className="memory-hub">
  <TabsList className="memory-hub-tabs" aria-label="Memory workspace">
   <TabsTrigger value="working"><BookOpen size={16} aria-hidden="true"/>Notes & history</TabsTrigger>
   <TabsTrigger value="learned"><BrainCircuit size={16} aria-hidden="true"/>Learned</TabsTrigger>
   <TabsTrigger value="honcho"><Database size={16} aria-hidden="true"/>Honcho</TabsTrigger>
   <TabsTrigger value="relations"><Network size={16} aria-hidden="true"/>Relations & access</TabsTrigger>
  </TabsList>
  <TabsContent value="working">{view==='working'&&<Memory/>}</TabsContent>
  <TabsContent value="learned">{view==='learned'&&<LearnedMemory/>}</TabsContent>
  <TabsContent value="honcho">{view==='honcho'&&<Honcho notify={notify}/>}</TabsContent>
  <TabsContent value="relations">{view==='relations'&&<MemoryMap/>}</TabsContent>
 </Tabs>;
}
