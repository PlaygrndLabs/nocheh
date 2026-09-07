"""One synthetic native Hermes memory turn; called in an isolated container."""
import contextlib
import io
import json
import logging
import os
import sys
from pathlib import Path


def run(body):
    run_id=body['run_id']
    if not run_id.isalnum(): raise ValueError('invalid_run_id')
    home=Path('/experiment-state')/run_id
    home.mkdir(parents=True,exist_ok=True)
    os.environ['HERMES_HOME']=str(home)
    (home/'config.yaml').write_text(json.dumps({'tools':{'tool_search':{'enabled':'off'}},
        'memory':{'memory_enabled':True,'user_profile_enabled':True},'fallback_models':[]}))
    from run_agent import AIAgent
    from hermes_state import SessionDB
    from integrations.hermes.assistant_turn import restrict_session_search
    restrict_session_search()
    database=SessionDB(home/'state.db')
    # New conversation on each call: recall must come from saved memory/session search.
    agent=AIAgent(provider='custom',api_mode='chat_completions',model='gpt-5.6-sol',
        base_url='http://meter:8790/v1',api_key=Path('/run/secrets/experiment_token').read_text().strip(),
        enabled_toolsets=['memory','session_search'],fallback_model=None,session_db=database,
        skip_context_files=True,skip_memory=False,skip_background_review=True,max_iterations=8,
        max_tokens=2500,run_budget_seconds=180,quiet_mode=True,save_trajectories=False,
        ephemeral_system_prompt='This is a synthetic memory evaluation. Preserve fixture source labels in memory. Answer only from the stored evidence; cite those labels and say UNKNOWN when absent.')
    try:
        if set(agent.valid_tool_names)!={'memory','session_search'}: raise RuntimeError('unexpected_baseline_tools')
        if body.get('check_only'): return {'state':'configured','tools':sorted(agent.valid_tool_names),'model_calls':0}
        result=agent.run_conversation(body['prompt'])
        return {'state':'done' if result.get('completed') and not result.get('failed') else 'failed',
                'text':result.get('final_response',''),'session_id':agent.session_id}
    finally: agent.close();database.close()


if __name__=='__main__':
    output=sys.stdout;logging.disable(logging.CRITICAL)
    try:
        body=json.loads(sys.stdin.buffer.read(1024*1024))
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()): result=run(body)
    except Exception as error: result={'state':'failed','error_type':type(error).__name__}
    output.write(json.dumps(result)+'\n')
