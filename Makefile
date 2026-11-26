# Tests of the Orca plugin. Orca loads src/ itself (no build): `make test` checks the manifest the way Orca loads it,
# type-checks src/ against the typings of this Orca, and runs the plugin's own tests with `orca plugin test`.
#
# agent-queue-kit: every `make test` records its result for the agent queue (docs/test-result.md in the kit).
# AGENT_QUEUE_CACHE_DIR moves it like the queue's cache_dir (the recorder reads a leading ~ as the home directory).
TEST_RESULT_DIR ?= $(or $(AGENT_QUEUE_CACHE_DIR),$(HOME)/.cache/agent-queue-kit/orca-plugin-agent-queue)/test-results
# The test_args of a full run.
test_args ?= --compact
# Orca's CLI: ORCA_CLI_COMMAND in Orca's terminals, otherwise `orca` on macOS and Windows and `orca-ide` elsewhere;
# `make test ORCA=…` picks another (a relative path counts from the directory make runs in). Never a bare `orca` on
# Linux: outside Orca that is GNOME's screen reader, and `test` refuses it. scripts/tools.mjs has the same rule.
ORCA_DEFAULT := $(if $(filter Darwin,$(shell uname -s 2>/dev/null))$(filter Windows_NT,$(OS)),orca,orca-ide)
ORCA ?= $(or $(ORCA_CLI_COMMAND),$(ORCA_DEFAULT))

# The run gets the chosen CLI, the CLI's name on this system, the results directory and the run's test_args from the
# environment, never as text of the recipe: blanks, backslashes or quotes in them stay whole. Plain `export` only — the
# GNU Make 3.81 of macOS reads no target-specific `override export`.
export PLUGIN_ORCA_CLI := $(ORCA)
export PLUGIN_ORCA_DEFAULT := $(ORCA_DEFAULT)
export PLUGIN_TEST_RESULT_DIR := $(TEST_RESULT_DIR)
export TEST_RESULT_ARGS = $(test_args)

# The run itself — the guards, the steps validate, types and plugin, the record — is scripts/make-test.sh, read by the
# recipe's own shell: a recipe that is not ASCII reaches sh garbled on Windows, where make passes it on the system's
# ANSI command line.
.PHONY: test
test:
	@. ./scripts/make-test.sh
