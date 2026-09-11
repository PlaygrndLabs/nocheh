.PHONY: init up dev down status logs build test verify login diagnose backup db
init up down status logs build test verify login diagnose backup db:
	./scripts/nocheh $@
