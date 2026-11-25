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
# Orca's CLI: ORCA_CLI_COMMAND in Orca's terminals, otherwise `orca` on macOS and Windows and `orca-ide` elsewhere;
# `make test ORCA=…` picks another. Never a bare `orca` on Linux: outside Orca that is GNOME's screen reader, and `test`
# refuses it. scripts/tools.mjs has the same rule.
ORCA_DEFAULT := $(if $(filter Darwin,$(shell uname -s 2>/dev/null))$(filter Windows_NT,$(OS)),orca,orca-ide)
ORCA ?= $(or $(ORCA_CLI_COMMAND),$(ORCA_DEFAULT))
# The chosen CLI reaches every step and the tests in one environment variable (ORCA_CLI_COMMAND, exported by `test`),
# and each step uses its value as one argument: a path with blanks or backslashes stays whole.
ORCA_CLI := $(ORCA)
# TypeScript by the path of its package: the preparation installs it without bin links (no node_modules/.bin).
TSC = node_modules/typescript/bin/tsc
# The preparation command of README, named when node_modules/ is missing.
PREPARE = npm ci --no-audit --no-fund --no-bin-links
# "major.minor" of the bash on PATH, which runs the recorder. The recorder needs bash 4.4 or newer: it reads lists with
# mapfile and expands arrays that may be empty under `set -u`, which bash before 4.4 refuses. macOS ships bash 3.2,
# where `start` would stop before noting the run and `make test` would still exit 0, with no record.
BASH_VERSION_ON_PATH = bash -c 'echo "$${BASH_VERSINFO[0]}.$${BASH_VERSINFO[1]}"' 2>/dev/null

# The checks of the manifest Orca makes when it loads the plugin; the last line is the step's summary.
VALIDATE = bash -c '"$$ORCA_CLI_COMMAND" plugin validate . && echo "orca plugin validate: манифест в порядке"' validate
# `orca plugin types` writes the typings of this Orca into .orca/ (ignored by git); tsc prints nothing when the types
# are right, so the step says so itself: a recorded step without output is never green.
TYPES = bash -c '"$$ORCA_CLI_COMMAND" plugin types . >/dev/null && node $(TSC) -p . && echo "tsc: типы в порядке"' types
# `orca plugin test` has no filter by name: a run with --filter=… in test_args runs every test and is recorded as
# filtered.
PLUGIN_TEST = bash -c '"$$ORCA_CLI_COMMAND" plugin test .' plugin

.PHONY: test
test: export TEST_RESULT_ARGS = $(test_args)
test: override export ORCA_CLI_COMMAND := $(ORCA_CLI)
test:
	@if [ "$(ORCA_DEFAULT)" = orca-ide ] && [ "$$ORCA_CLI_COMMAND" = orca ]; then \
	    echo "make test: CLI Orca «orca» без пути на Linux — экранный диктор GNOME, а не CLI Orca;" \
	        "задайте orca-ide или полный путь CLI (ORCA_CLI_COMMAND или ORCA=…)" >&2; \
	    exit 1; \
	fi
	@[ -z "$(TEST_RESULT_DIR)" ] || case "$$($(BASH_VERSION_ON_PATH))" in [0-3].*|4.[0-3]|"") \
	    echo "make test: запись итога (docker/test-result.sh) требует bash 4.4 или новее, а bash в PATH —" \
	        "«$$($(BASH_VERSION_ON_PATH))»; на macOS поставьте новый bash (например brew install bash)" >&2; \
	    exit 1 ;; \
	esac
	@test -f $(TSC) || { echo "make test: нет node_modules — сначала $(PREPARE)" >&2; exit 1; }
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
