# Tests of the Orca plugin. Orca loads src/ itself (no build): `make test` checks the manifest the way Orca loads it,
# type-checks src/ against the typings of this Orca, and runs the plugin's own tests with `orca plugin test`.
#
# agent-queue-kit: every `make test` records its result for the agent queue (docs/test-result.md in the kit).
# AGENT_QUEUE_CACHE_DIR moves it like the queue's cache_dir (the recorder reads a leading ~ as the home directory).
TEST_RESULT_DIR ?= $(or $(AGENT_QUEUE_CACHE_DIR),$(HOME)/.cache/agent-queue-kit/orca-plugin-agent-queue)/test-results
TEST_RESULT = bash docker/test-result.sh
# The steps a full run must run, and the test_args of a full run.
TEST_STEPS = validate types plugin
test_args ?= --compact
# Orca's CLI: ORCA_CLI_COMMAND in Orca's terminals, otherwise orca-ide (never a bare `orca`: on Linux outside Orca
# that is GNOME's screen reader).
ORCA ?= $(or $(ORCA_CLI_COMMAND),orca-ide)

# The checks of the manifest Orca makes when it loads the plugin; the last line is the step's summary.
VALIDATE = bash -c '"$$1" plugin validate . && echo "orca plugin validate: манифест в порядке"' validate $(ORCA)
# `orca plugin types` writes the typings of this Orca into .orca/ (ignored by git); tsc prints nothing when the types
# are right, so the step says so itself: a recorded step without output is never green.
TYPES = bash -c '"$$1" plugin types . >/dev/null && node_modules/.bin/tsc -p . && echo "tsc: типы в порядке"' types $(ORCA)
# `orca plugin test` has no filter by name: a run with --filter=… in test_args runs every test and is recorded as
# filtered.
PLUGIN_TEST = $(ORCA) plugin test .

.PHONY: test
test: export TEST_RESULT_ARGS = $(test_args)
test:
	@test -x node_modules/.bin/tsc || { echo "make test: нет node_modules — сначала npm ci" >&2; exit 1; }
	@run=; [ -z "$(TEST_RESULT_DIR)" ] || run="$$(mktemp -u -t test-run.XXXXXXXX)"; status=0; \
	[ -z "$$run" ] || $(TEST_RESULT) start "$$run" "$(TEST_RESULT_DIR)"; \
	for step in $(TEST_STEPS); do \
	    case "$$step" in \
	        validate) set -- $(VALIDATE) ;; \
	        types) set -- $(TYPES) ;; \
	        plugin) set -- $(PLUGIN_TEST) ;; \
	    esac; \
	    code=0; \
	    if [ -n "$$run" ]; then $(TEST_RESULT) step "$$run" "$$step" "$$@"; else "$$@"; fi || code=$$?; \
	    [ "$$status" -ne 0 ] || status=$$code; \
	done; \
	[ -z "$$run" ] || TEST_RESULT_STEPS="$(TEST_STEPS)" $(TEST_RESULT) finish "$$run" "$$status"; \
	exit "$$status"
