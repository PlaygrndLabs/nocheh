.PHONY: init up dev down status logs build test verify login diagnose backup
init up down status logs build test verify login diagnose backup:
	./scripts/nocheh $@
