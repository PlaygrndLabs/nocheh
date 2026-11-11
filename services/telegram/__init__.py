"""Nocheh's Telegram front door: the only process that holds the bot token, polls Telegram and sends to it.

The brain never talks to Telegram. Nocheh's core asks this service to show presence, deliver a reply,
send a card or a notice; every send is journaled before it leaves (ADR-0235).
"""
