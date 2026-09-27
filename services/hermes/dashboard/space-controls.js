// Uses the host React instance. The runtime-platform dashboard can reuse this
// component by supplying its authenticated call function.
export function createSpaceControls(React, call) {
  const {createElement:h,useEffect,useState}=React;
  const button=(text,onClick,disabled=false)=>h('button',{type:'button',onClick,disabled},text);
  const panel=(title,...children)=>h('section',{className:'n-panel'},h('h2',null,title),...children);
  const modes={isolated:'Own context only',approved:'Approved sharing',filtered:'Automatic privacy filtering'};
  return function SpaceControls(){
    const [space,setSpace]=useState(''),[typed,setTyped]=useState(''),[spaces,setSpaces]=useState([]),[after,setAfter]=useState(''),[next,setNext]=useState(null);
    const [policy,setPolicy]=useState(null),[draft,setDraft]=useState({}),[shares,setShares]=useState([]),[jobs,setJobs]=useState([]),[jobAfter,setJobAfter]=useState(''),[jobNext,setJobNext]=useState(null);
    const [text,setText]=useState(''),[sourceIds,setSourceIds]=useState(''),[query,setQuery]=useState(''),[preview,setPreview]=useState(null),[recall,setRecall]=useState(null);
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[tick,setTick]=useState(0),[policyTick,setPolicyTick]=useState(0);
    useEffect(()=>{let alive=true;
      call('/memory/spaces?after='+encodeURIComponent(after)).then(result=>{if(!alive)return;
        setSpaces(old=>[...new Map([...old,...result.spaces].map(s=>[s.id,s])).values()]);setNext(result.next);
        if(result.spaces.length)setSpace(current=>current||result.spaces.find(s=>s.id!==result.owner_space)?.id||result.spaces[0].id);
      }).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};
    },[after,tick]);
    useEffect(()=>{let alive=true;setPolicy(null);setPreview(null);setText('');setSourceIds('');setError('');if(!space)return()=>{alive=false;};
      Promise.all([call('/memory/spaces?id='+encodeURIComponent(space)),call('/memory/shares?space='+encodeURIComponent(space))]).then(([p,s])=>{
        if(alive){setPolicy(p);setDraft(p.overrides);setShares(s);}
      }).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};
    },[space,policyTick]);
    useEffect(()=>{let alive=true;
      call('/memory/reviews?after='+encodeURIComponent(jobAfter)).then(result=>{if(alive){setJobs(result.jobs);setJobNext(result.next);}}).catch(e=>{if(alive)setError(e.message);});
      return()=>{alive=false;};
    },[jobAfter,tick]);
    const run=async(task,success,refreshPolicy=false)=>{setBusy(true);setError('');setNotice('');try{await task();setNotice(success);setTick(v=>v+1);if(refreshPolicy)setPolicyTick(v=>v+1);}catch(e){setError(e.message==='space_revision_conflict'?'Settings changed elsewhere. Refresh and review your edits before saving.':e.message);}finally{setBusy(false);}};
    const update=(key,value)=>setDraft(d=>({...d,[key]:value}));
    const effective=policy?{...policy.inherited,...draft}:null;
    return h('div',null,
      error&&h('p',{role:'alert',className:'n-notice n-error'},error),notice&&h('p',{role:'status',className:'n-notice'},notice),
      panel('Spaces and sharing',h('p',{className:'n-muted'},'Your private assistant connects all your knowledge. Each shared space controls what it can retrieve. Changes apply to the next turn and retire previous group memory contexts.'),
        h('label',null,'Group or topic',h('select',{value:space,disabled:busy,onChange:e=>setSpace(e.target.value)},h('option',{value:''},'Choose a space'),...spaces.map(s=>h('option',{key:s.id,value:s.id},s.id+(s.parent?' · topic':''))))),
        next&&button('Load more spaces',()=>setAfter(next),busy),
        h('form',{className:'n-actions',onSubmit:e=>{e.preventDefault();setSpace(typed.trim());}},h('label',{className:'n-grow'},'Open another space',h('input',{value:typed,onChange:e=>setTyped(e.target.value),placeholder:'-100123 or -100123/topic/42',required:true,disabled:busy})),h('button',{disabled:busy},'Open'))),
      space&&!policy&&!error&&h('p',{role:'status'},'Loading space settings…'),
      policy?.private_owner&&panel('Private owner memory',h('p',null,'Your private DM can recall across all sources and registered Hermes profiles. Choose a group or topic to configure shared access.')),
      policy&&!policy.private_owner&&panel('Memory access',h('p',{className:'n-muted'},policy.parent?'Inherits from '+policy.parent+'. Effective mode: '+modes[policy.effective.mode]+'.':'Application default: approved sharing.'),
        h('form',{onSubmit:e=>{e.preventDefault();run(()=>call('/memory/spaces',{id:space,overrides:draft,revision:policy.revision}),'Space settings saved.',true);}},
          h('label',null,'Sharing mode',h('select',{value:draft.mode??'',disabled:busy,onChange:e=>{const value=e.target.value;setDraft(d=>{const next={...d};if(value)next.mode=value;else delete next.mode;return next;});}},h('option',{value:''},'Inherit · '+modes[policy.inherited.mode]),...Object.entries(modes).map(([value,label])=>h('option',{key:value,value},label)))),
          effective.mode==='filtered'&&h('div',null,h('p',{className:'n-muted'},'Opt-in: relevant text from selected sources is sent to the configured ChatGPT subscription for privacy filtering. Filtering can miss personal details. The group receives derived text, never unrestricted access.'),
            h('label',null,'Eligible source spaces · one per line',h('textarea',{rows:4,value:(draft.sources??policy.inherited.sources).join('\n'),disabled:busy,onChange:e=>update('sources',e.target.value.split('\n').map(s=>s.trim()).filter(Boolean))})),
            h('label',null,'Additional privacy instructions',h('textarea',{rows:4,value:draft.privacy_instructions??policy.inherited.privacy_instructions,disabled:busy,onChange:e=>update('privacy_instructions',e.target.value)}))),
          h('div',{className:'n-actions'},h('button',{className:'n-primary',disabled:busy},'Save access policy'),button('Use inherited settings',()=>setDraft({}),busy),button('Refresh saved settings',()=>setPolicyTick(v=>v+1),busy)))),
      policy&&!policy.private_owner&&panel('Approve exact knowledge for this space',h('p',{className:'n-muted'},'Share only the text shown here. Linking an original records private provenance; it does not grant access to the complete source. Parent-group shares are inherited unless a topic uses own context only.'),
        h('form',{onSubmit:e=>{e.preventDefault();run(async()=>{await call('/memory/shares',{destination:space,content:text,source_ids:sourceIds.split(/\s+/).filter(Boolean).map(s=>s.replace('nocheh:event:','')),revision:policy.revision});setText('');setSourceIds('');},'Knowledge approved for this space.',true);}},
          h('label',null,'Text to share',h('textarea',{value:text,rows:4,maxLength:12000,required:true,disabled:busy,onChange:e=>setText(e.target.value)})),
          h('label',null,'Supporting event IDs · optional',h('textarea',{value:sourceIds,rows:2,disabled:busy,onChange:e=>setSourceIds(e.target.value)})),h('button',{disabled:busy||!text.trim(),className:'n-primary'},'Approve sharing')),
        ...shares.map(s=>h('article',{className:'n-result',key:s.id},h('small',null,s.destination===space?'This space':'Inherited from '+s.destination),h('p',{dir:'auto'},s.content),s.revoked_at?h('span',null,'Revoked'):button(s.destination===space?'Revoke this shared text':'Revoke for parent group and all its topics',()=>run(()=>call('/memory/shares/revoke',{id:s.id,revision:policy.revision}),'Sharing revoked. Previously posted messages cannot be recalled.',true),busy)))),
      panel('Recall and access preview',h('form',{className:'n-actions',onSubmit:e=>{e.preventDefault();run(async()=>{
        const [native,archive]=await Promise.all([call('/memory/recall',{query}),call('/search?q='+encodeURIComponent(query))]);setRecall({native,archive});
      },'Private recall loaded.');}},h('label',{className:'n-grow'},'Search your knowledge',h('input',{type:'search',value:query,required:true,onChange:e=>setQuery(e.target.value),disabled:busy})),h('button',{disabled:busy},'Search all private knowledge'),button('Preview space access',()=>run(async()=>setPreview(await call('/memory/preview?space='+encodeURIComponent(space)+'&q='+encodeURIComponent(query))),'Space access preview loaded.'),busy||!space||!!policy?.private_owner||!query.trim())),
        preview&&h('div',null,h('h3',null,'What '+space+' can retrieve'),h('p',{className:'n-muted'},'This preview does not run a model. Filtered-mode sources are eligible for review, not automatically disclosed.'),
          ...[...preview.originals,...preview.shares].map((s,i)=>h('article',{className:'n-result',key:s.source||i},h('small',null,s.source),h('p',{dir:'auto'},s.text))),h('p',null,'Eligible for filtering: '+(preview.filtered_sources.join(', ')||'None'))),
        recall&&h('div',null,h('h3',null,'Owner-only results'),...[...(recall.native.hits??[]),...recall.archive].map((s,i)=>h('article',{className:'n-result',key:i},h('small',null,s.kind+' · '+(s.profile||s.scope)),h('p',{dir:'auto'},s.text))),(recall.native.truncated||recall.native.next_profile)&&h('p',null,'Native results are limited. Refine your search or select a profile through the CLI.'))),
      panel('Hermes learning jobs',h('p',{className:'n-muted'},'Imported chats enter this queue only after your approval. Running reviews finish before their worker closes. An interrupted review may require an explicit resume.'),
        button('Refresh jobs',()=>setTick(v=>v+1),busy),jobs.length===0&&h('p',null,'No review jobs on this page.'),
        ...jobs.map(j=>h('article',{className:'n-result',key:j.id},h('p',null,j.reason==='live'?'Conversation review':'Owner-approved review'),h('small',null,j.event_id+' · part '+(j.chunk_index+1)),h('p',{role:'status'},j.state+(j.error_code?' · '+j.error_code:'')),
          !['done','running'].includes(j.state)&&button(j.state==='paused'||j.state==='ambiguous'?'Resume review':'Pause review',()=>run(()=>call('/memory/reviews/control',{id:j.id,action:j.state==='paused'||j.state==='ambiguous'?'resume':'pause'}),'Review job updated.'),busy))),
        h('div',{className:'n-actions'},jobAfter&&button('First page',()=>setJobAfter(''),busy),jobNext&&button('Next page',()=>setJobAfter(jobNext),busy))));
  };
}
