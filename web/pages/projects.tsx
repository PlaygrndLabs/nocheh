import {useState} from 'react';
import {Badge,Button,Alert,EmptyState,Sheet} from '../components/ui/primitives';
import {useResource} from '../lib/resource';
import {CursorButtons,Provenance,ResourceState,useOwnerCommand} from '../lib/owner-controls';

type Project={id:string;name:string;description:string;state:'active'|'archived';revision:number};
type Assignment={space_id:string;project_id:string|null;mode:string;revision:number};
function ProjectEditor({project,onSaved}:{project:Project|null;onSaved:()=>void}){
 const [name,setName]=useState(project?.name||''),[description,setDescription]=useState(project?.description||''),[state,setState]=useState(project?.state||'active'),command=useOwnerCommand();
 return <form className="owner-form" onSubmit={e=>{e.preventDefault();void command.run('/projects',{...(project?{id:project.id}:{}),name,description,state,expected_revision:project?.revision??0}).then(result=>{if(result)onSaved();});}}>
 <label>Project name<input value={name} maxLength={200} required onChange={e=>setName(e.target.value)} disabled={command.busy}/></label>
 <label>Description<textarea rows={4} value={description} maxLength={4000} onChange={e=>setDescription(e.target.value)} disabled={command.busy}/></label>
 <label>Status<select value={state} onChange={e=>setState(e.target.value as Project['state'])} disabled={command.busy}><option value="active">Active</option><option value="archived">Archived</option></select></label>
 {project&&<Provenance value={{id:project.id,revision:project.revision}} label="Project identifier and revision"/>}
 {command.error&&<Alert>{command.error}</Alert>}<Button type="submit" variant="default" disabled={command.busy||!name.trim()}>{command.busy?'Saving…':project?'Save project':'Create project'}</Button>
 </form>;
}
function AssignmentEditor({space,projects,onSaved}:{space:string;projects:Project[];onSaved:()=>void}){
 const [edit,setEdit]=useState(0);
 const effective=useResource<{project:Project|null;inherited:boolean;own_assignment:Assignment|null}>('/projects/effective?space='+encodeURIComponent(space));
 return <><ResourceState {...effective} hasData={!!effective.data}/>{effective.data&&<AssignmentForm key={space+':'+edit} space={space} projects={projects} current={effective.data} onSaved={()=>{setEdit(v=>v+1);onSaved();}}/>}</>;
}
function AssignmentForm({space,projects,current,onSaved}:{space:string;projects:Project[];current:{project:Project|null;inherited:boolean;own_assignment:Assignment|null};onSaved:()=>void}){
 const [base]=useState(current);
 const [mode,setMode]=useState(current.own_assignment?.mode??'inherit'),[project,setProject]=useState(current.own_assignment?.project_id??current.project?.id??''),command=useOwnerCommand();
 const choices=[...projects.filter(p=>p.state==='active')];if(current.project&&!choices.some(p=>p.id===current.project!.id))choices.push(current.project);
 return <form className="owner-form" onSubmit={e=>{e.preventDefault();void command.run('/projects/assignments',{space_id:space,mode,project_id:mode==='assigned'?project:null,
  expected_revision:base.own_assignment?.revision??0}).then(result=>{if(result)onSaved();});}}>
 <p>Effective project: <strong>{current.project?.name??'None'}</strong>{current.inherited?' · inherited from the group':''}{current.project?.state==='archived'?' · archived':''}</p>
 {(current.own_assignment?.revision??0)!==(base.own_assignment?.revision??0)&&<Alert>The assignment changed elsewhere. Your draft is retained. <Button onClick={onSaved}>Discard draft and load latest</Button></Alert>}
 <label>Assignment<select value={mode} onChange={e=>setMode(e.target.value)} disabled={command.busy}><option value="inherit">Inherit from the group</option><option value="assigned">Assign a project</option><option value="none">No project for this conversation</option></select></label>
 {mode==='assigned'&&<label>Project<select value={project} required onChange={e=>setProject(e.target.value)} disabled={command.busy}><option value="">Choose a project</option>{choices.map(p=><option key={p.id} value={p.id} disabled={p.state==='archived'}>{p.name}{p.state==='archived'?' (archived)':''}</option>)}</select><small>Projects on the current page are available here. Use the project list to browse more.</small></label>}
 {command.error&&<Alert>{command.error}</Alert>}<Button type="submit" variant="default" disabled={command.busy||mode==='assigned'&&!project}>{command.busy?'Saving…':'Save assignment'}</Button></form>;
}
export function Projects(){
 const [pages,setPages]=useState(['']),[assignmentPages,setAssignmentPages]=useState(['']),[editor,setEditor]=useState<Project|'new'|null>(null),[trigger,setTrigger]=useState<HTMLElement|null>(null),[draftSpace,setDraftSpace]=useState(''),[space,setSpace]=useState('');
 const projects=useResource<{projects:Project[];next:string|null}>('/projects?after='+pages.at(-1)),assignments=useResource<{assignments:Assignment[];next:string|null}>('/projects/assignments?after='+assignmentPages.at(-1));
 const scopes=useResource<{scopes:{scope:string}[]}>('/scopes');
 return <><section className="n-panel"><div className="list-heading"><div><h2>Your projects</h2><p className="n-muted">Organize conversations and interpretation conventions. Project membership does not share chat content.</p></div><Button variant="default" onClick={e=>{setTrigger(e.currentTarget);setEditor('new');}}>New project</Button></div>
 <ResourceState {...projects} hasData={!!projects.data}/>{projects.data&&!projects.data.projects.length&&<EmptyState title="No projects yet">Create a project, then assign its conversations below.</EmptyState>}
 <div className="owner-records">{projects.data?.projects.map(project=><article key={project.id}><div className="list-heading"><h3>{project.name}</h3><Badge>{project.state==='active'?'Active':'Archived'}</Badge></div><p>{project.description||'No description'}</p>
 <div className="n-actions"><Button onClick={e=>{setTrigger(e.currentTarget);setEditor(project);}}>Edit project</Button><a href={'#learned?project='+project.id}>Learned project conventions</a></div><Provenance value={project.id} label="Project identifier"/></article>)}</div>
 <CursorButtons pages={pages} next={projects.data?.next} onChange={setPages}/></section>
 <section className="n-panel"><h2>Conversation assignments</h2><p className="n-muted">Each chat or topic has one effective project. Topics inherit their group’s assignment unless you choose another project or no project.</p>
 <form className="search-toolbar" onSubmit={e=>{e.preventDefault();setSpace(draftSpace.trim());}}><label className="n-grow">Chat or topic<input value={draftSpace} onChange={e=>setDraftSpace(e.target.value)} list="project-conversations" placeholder="Chat ID or chat ID/topic/topic ID" required/></label><Button type="submit">Manage assignment</Button></form>
 <datalist id="project-conversations">{scopes.data?.scopes.map(s=><option key={s.scope} value={s.scope}/>)}</datalist>
 {space&&<div className="owner-assignment"><h3>Assignment for <span className="owner-identifier">{space}</span></h3><AssignmentEditor key={space} space={space} projects={projects.data?.projects??[]} onSaved={()=>{}}/></div>}
 <ResourceState {...assignments} hasData={!!assignments.data}/><div className="owner-records">{assignments.data?.assignments.map(assignment=><article key={assignment.space_id} className="owner-assignment-row"><div><strong className="owner-identifier">{assignment.space_id}</strong><p>{assignment.mode==='assigned'?projects.data?.projects.find(p=>p.id===assignment.project_id)?.name??'Assigned project':assignment.mode==='none'?'No project':'Inherit from group'}</p></div><Button onClick={()=>{setDraftSpace(assignment.space_id);setSpace(assignment.space_id);}}>Manage</Button></article>)}</div>
 <CursorButtons pages={assignmentPages} next={assignments.data?.next} onChange={setAssignmentPages}/></section>
 <Sheet open={editor!==null} onOpenChange={open=>{if(!open)setEditor(null);}} title={editor==='new'?'Create project':'Edit project'} returnFocus={trigger}>{editor&&<ProjectEditor key={editor==='new'?'new':editor.id} project={editor==='new'?null:editor} onSaved={()=>setEditor(null)}/>}</Sheet></>;
}
