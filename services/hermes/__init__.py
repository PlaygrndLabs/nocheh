"""Native Hermes plugin entry point; no bot or agent implementation lives here."""


def register(ctx):
    # Hermes loads plugins under hermes_plugins.NAME. Import runtime context
    # modules by their stable name so dispatcher and tool share one ContextVar.
    from services.hermes.archive_tools import register as register_archive
    register_archive(ctx)
    import os
    # Hermes's own terminal, file and code tools run only in a job's sealed box: the hook
    # blocks them everywhere else, and the box backend exists only where its socket is mounted.
    from services.hermes import job_box
    ctx.register_hook('pre_tool_call', job_box.tool_gate)
    if os.environ.get('NOCHEH_BOX_SOCKET'):
        ctx.register_terminal_environment_provider(job_box.Provider())
    if os.environ.get('NOCHEH_CAPTURE_ENABLED') == '1':
        from plugins.platforms.telegram import adapter as native
        from services.hermes.capture import captured_adapter_class
        class Registration:
            def __getattr__(self, name):
                return getattr(ctx, name)
            def register_platform(self, **kwargs):
                kwargs['adapter_factory'] = lambda config: captured_adapter_class()(config)
                ctx.register_platform(**kwargs)
        # Preserve all native setup/permission/formatting metadata. Only the
        # adapter factory changes; registry registration removes its deferred loader.
        native.register(Registration())
