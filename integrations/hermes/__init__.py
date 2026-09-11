"""Native Hermes plugin entry point; no bot or agent implementation lives here."""


def register(ctx):
    from .transcription import SubscriptionTranscriptionProvider

    ctx.register_transcription_provider(SubscriptionTranscriptionProvider())
    # Hermes loads plugins under hermes_plugins.NAME. Import runtime context
    # modules by their stable name so dispatcher and tool share one ContextVar.
    from integrations.hermes.archive_tools import register as register_archive
    register_archive(ctx)
    import os
    if os.environ.get('NOCHEH_CAPTURE_ENABLED') == '1':
        from plugins.platforms.telegram import adapter as native
        from integrations.hermes.capture import captured_adapter_class
        class Registration:
            def __getattr__(self, name):
                return getattr(ctx, name)
            def register_platform(self, **kwargs):
                kwargs['adapter_factory'] = lambda config: captured_adapter_class()(config)
                ctx.register_platform(**kwargs)
        # Preserve all native setup/permission/formatting metadata. Only the
        # adapter factory changes; registry registration removes its deferred loader.
        native.register(Registration())
