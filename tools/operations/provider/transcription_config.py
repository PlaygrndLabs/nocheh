"""Voice-note transcription models and prices; credentials never belong here."""
DEFAULTS = {'NOCHEH_TRANSCRIPTION_PROVIDER': 'openai', 'NOCHEH_TRANSCRIPTION_MODEL': 'gpt-transcribe'}
# USD per minute of audio, official OpenAI model pages checked 2026-10-29. Hermes's transcriber
# knows each of these models, including how long a recording each accepts at once.
MODELS = {'gpt-transcribe': 0.0045, 'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003, 'whisper-1': 0.006}
