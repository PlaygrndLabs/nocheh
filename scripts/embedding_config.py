"""Reviewed embedding routes and costs; credentials never belong in this object."""
from dataclasses import dataclass

DEFAULTS={'NOCHEH_EMBEDDING_PROVIDER':'openai','NOCHEH_EMBEDDING_MODEL':'text-embedding-3-small','OPENAI_API_KEY':''}
# USD / million input tokens, official OpenAI model pages checked 2026-09-09.
MODELS={'text-embedding-3-small':(0.02,10_000),'text-embedding-3-large':(0.13,20_000)}


@dataclass(frozen=True)
class Embeddings:
    provider:str
    model:str
    dimensions:int
    price_per_million:float
    reservation:int
    url:str='https://api.openai.com/v1/embeddings'


def embeddings(values):
    provider=values.get('NOCHEH_EMBEDDING_PROVIDER',DEFAULTS['NOCHEH_EMBEDDING_PROVIDER'])
    model=values.get('NOCHEH_EMBEDDING_MODEL',DEFAULTS['NOCHEH_EMBEDDING_MODEL'])
    if provider!='openai':raise ValueError('NOCHEH_EMBEDDING_PROVIDER must be openai')
    if model not in MODELS:raise ValueError('NOCHEH_EMBEDDING_MODEL must be text-embedding-3-small or text-embedding-3-large')
    price,reservation=MODELS[model]
    return Embeddings(provider,model,1536,price,reservation)
