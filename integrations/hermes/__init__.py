"""Native Hermes plugin entry point; no bot or agent implementation lives here."""


def register(ctx):
    from .transcription import SubscriptionTranscriptionProvider

    ctx.register_transcription_provider(SubscriptionTranscriptionProvider())
