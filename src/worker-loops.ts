// Each stage progresses independently, but never overlaps another run of itself.
export function startLoops(jobs:Record<string,()=>Promise<unknown>>,interval=1000,
  failure:(stage:string)=>void=stage=>console.error(JSON.stringify({event:'worker_stage_failed',stage}))):()=>Promise<void> {
  let stopped=false;
  const active=new Map<string,Promise<void>>();
  const run=(stage:string,job:()=>Promise<unknown>)=>{
    if (stopped || active.has(stage)) return;
    const promise=Promise.resolve().then(job).then(()=>{},()=>failure(stage)).finally(()=>active.delete(stage));
    active.set(stage,promise);
  };
  const tick=()=>{for(const [stage,job] of Object.entries(jobs))run(stage,job);};
  const timer=setInterval(tick,interval);tick();
  return async()=>{stopped=true;clearInterval(timer);await Promise.all(active.values());};
}
