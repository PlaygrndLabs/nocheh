"""Native Hermes plugin entry point; no bot or agent implementation lives here.

Nocheh's data tools are not plugin tools: each turn connects Nocheh's MCP endpoint (assistant_turn.connect_data_tools).
"""


def register(ctx):
    # Hermes loads plugins under hermes_plugins.NAME. Import runtime context
    # modules by their stable name so the turn and its hooks share one module state.
    import os
    # Hermes's own terminal, file and code tools run only in a job's sealed box or on its machine: the
    # hook blocks them everywhere else, and the box backend exists only where its socket is mounted.
    from services.hermes import job_box
    ctx.register_hook('pre_tool_call', job_box.tool_gate)
    if os.environ.get('NOCHEH_BOX_SOCKET'):
        ctx.register_terminal_environment_provider(job_box.Provider())
    # A job run on the owner's machine: its terminal and file tools go there through Nocheh, and only
    # where the launcher made the turn for such a run. The middleware tags each command for the machine log.
    if os.environ.get('NOCHEH_MACHINE_RUN') == '1':
        from services.hermes import machine_box
        ctx.register_hook('pre_tool_call', machine_box.tool_call)
        ctx.register_middleware('tool_execution', machine_box.tool_execution)
        ctx.register_terminal_environment_provider(machine_box.Provider())
    # A background job run's counts, to-do list and cost notice; inert unless the run's turn binds it.
    from services.hermes import job_progress
    ctx.register_hook('post_api_request', job_progress.api_request)
    ctx.register_hook('post_auxiliary_call', job_progress.auxiliary_call)
    ctx.register_hook('post_tool_call', job_progress.tool_call)
    ctx.register_hook('transform_tool_result', job_progress.tool_result)
