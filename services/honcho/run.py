"""Launch the pinned Honcho API/deriver with Nocheh's scoped egress binding."""
import os
import runpy
import sys
sys.path.insert(0,'/app')
from boundary import WorkspaceMiddleware,bind_worker,install_transport
import httpx
install_transport(httpx)
if sys.argv[1]=='api':
    from src.main import app
    from provenance import install
    install(app)
    app.add_middleware(WorkspaceMiddleware)
    import uvicorn
    uvicorn.run(app,host='0.0.0.0',port=8000,log_level='warning',access_log=False)
elif sys.argv[1]=='deriver':
    from src.deriver.queue_manager import QueueManager,parse_work_unit_key
    bind_worker(QueueManager,parse_work_unit_key)
    runpy.run_module('src.deriver',run_name='__main__')
else: raise SystemExit('invalid_mode')
