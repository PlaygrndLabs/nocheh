.PHONY: init up dev dev-build dev-stop dev-status down status logs build test verify login diagnose backup db
init up down status logs build test verify login diagnose backup db:
	./bin/nocheh $@
dev dev-stop dev-status:
	./bin/nocheh $@
dev-build:
	NOCHEH_DEV_BUILD=1 ./bin/nocheh dev
