"""Reviewed embedding routes and costs; credentials never belong in this object."""
from dataclasses import dataclass

DEFAULTS={'NOCHEH_EMBEDDING_PROVIDER':'openai','NOCHEH_EMBEDDING_MODEL':'text-embedding-3-small','OPENAI_API_KEY':''}
# USD / million input tokens, official OpenAI model pages checked 2026-09-09.
MODELS={'text-embedding-3-small':(0.02,10_000),'text-embedding-3-large':(0.13,20_000)}


@dataclass(frozen=True)
class Embeddings:
    provider:str  # API shape Honcho speaks to the meter; any configured OpenAI-compatible provider serves it.
    model:str
    dimensions:int
    price_per_million:float
    reservation:int
    url:str='https://api.openai.com/v1/embeddings'


def embeddings(values):
    """The configured provider id is checked against Settings providers by
    routes.validate; the meter receives only the resolved address."""
    model=values.get('NOCHEH_EMBEDDING_MODEL',DEFAULTS['NOCHEH_EMBEDDING_MODEL'])
    if model not in MODELS:raise ValueError('NOCHEH_EMBEDDING_MODEL must be text-embedding-3-small or text-embedding-3-large')
    url=(values.get('NOCHEH_EMBEDDING_URL') or 'https://api.openai.com/v1').rstrip('/')
    if not url.startswith('https://'):raise ValueError('NOCHEH_EMBEDDING_URL must use https')
    price,reservation=MODELS[model]
    return Embeddings('openai',model,1536,price,reservation,url+'/embeddings')
