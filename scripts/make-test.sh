# The run of `make test` (Makefile): the recipe's own shell reads this file (`. ./scripts/make-test.sh`), so it runs in
# the shell make starts — /bin/sh, POSIX sh only: dash on Linux, bash 3.2 on macOS, the sh of Git Bash on Windows. The
# text comes from this file, not from the recipe: the GNU Make of Windows hands a recipe to sh through the system's ANSI
# command line, which garbles every character that is not ASCII (the Russian lines below). Values go into messages as
# printf arguments, never next to a non-ASCII character in a word: bash 3.2 of macOS reads such a byte as part of the
# variable's name.
#
# From the Makefile, through the environment: PLUGIN_ORCA_CLI (the chosen CLI), PLUGIN_ORCA_DEFAULT (Orca's CLI name of
# this system: orca-ide or orca), PLUGIN_TEST_RESULT_DIR (where the recorder writes; empty: no record) and
# TEST_RESULT_ARGS (the run's test_args, for the recorder).
#
# One shell for the whole run: the CLI and the results directory are settled once, then the guards, then the steps.
# - The CLI: a relative path (one with a directory in it) is anchored to the physical directory make runs in (pwd -P:
#   the kernel and path.resolve then read it alike, also in a checkout entered through a symlink); a bare `orca` on
#   Linux is refused: outside Orca that is GNOME's screen reader.
# - The results directory: a native Windows path (C:\…) goes to the recorder in the shell's form (cygpath -u in Git
#   Bash and MSYS2): the recorder takes only absolute POSIX paths and ~. If it cannot be converted, `make test` stops
#   before the tests instead of running without a record.
# - Recording needs bash 4.4 or newer on PATH (docker/test-result.sh reads lists with mapfile and expands arrays that
#   may be empty under `set -u`); macOS ships bash 3.2, with which `start` would stop before noting the run.
# - The run's scratch directory for the recorder: a new directory of its own in the system's temporary directory
#   (TMPDIR, TMP, TEMP, else /tmp; a Windows path in the shell's form), and the recorder gets a path inside it that does
#   not exist yet. If none can be made, `make test` stops before the tests instead of running without a record.

# The steps of a full run, in order; each one's last line of output is its summary in the record.
steps='validate types plugin'
# TypeScript by the path of its package: the preparation installs it without bin links (no node_modules/.bin).
tsc=node_modules/typescript/bin/tsc
# The preparation command of README, named when node_modules/ is missing.
prepare='npm ci --no-audit --no-fund --no-bin-links'

cli="$PLUGIN_ORCA_CLI"
case "$cli" in
    /* | [A-Za-z]:[\\/]*) ;;
    */* | *\\*) cli="$(pwd -P)/$cli" ;;
esac
if [ "$PLUGIN_ORCA_DEFAULT" = orca-ide ] && [ "$cli" = orca ]; then
    printf '%s\n' "make test: CLI Orca «orca» без пути на Linux — экранный диктор GNOME, а не CLI Orca; задайте orca-ide или полный путь CLI (ORCA_CLI_COMMAND или ORCA=…)" >&2
    exit 1
fi
ORCA_CLI_COMMAND="$cli"
export ORCA_CLI_COMMAND

results="$PLUGIN_TEST_RESULT_DIR"
case "$results" in
    [A-Za-z]:[\\/]*)
        results="$(cygpath -u "$results")" || results=
        case "$results" in
            /*) ;;
            *)
                printf 'make test: каталог записи итога «%s» — путь Windows, а cygpath -u не дал пути оболочки: запись итога не начать; запустите make test в Git Bash или MSYS2 либо задайте каталог путём POSIX\n' \
                    "$PLUGIN_TEST_RESULT_DIR" >&2
                exit 1
                ;;
        esac
        ;;
esac
if [ -n "$results" ]; then
    bash_version="$(bash -c 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"' 2>/dev/null)"
    case "$bash_version" in
        [0-3].* | 4.[0-3] | "")
            printf 'make test: запись итога (docker/test-result.sh) требует bash 4.4 или новее, а bash в PATH — «%s»; на macOS поставьте новый bash (например brew install bash)\n' \
                "$bash_version" >&2
            exit 1
            ;;
    esac
fi
if [ ! -f "$tsc" ]; then
    printf 'make test: нет node_modules — сначала %s\n' "$prepare" >&2
    exit 1
fi

run=
scratch=
if [ -n "$results" ]; then
    temp="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
    case "$temp" in
        [A-Za-z]:[\\/]*) temp="$(cygpath -u "$temp" 2>/dev/null)" || temp= ;;
    esac
    case "$temp" in
        /*) scratch="$(mktemp -d "$temp/test-run.XXXXXXXX" 2>/dev/null)" || scratch= ;;
    esac
    case "$scratch" in
        /*) ;;
        *)
            printf 'make test: временный каталог прогона для записи итога не создать в «%s» (TMPDIR, TMP, TEMP, иначе /tmp): запись итога не начать; задайте TMPDIR — каталог, куда можно писать\n' \
                "$temp" >&2
            exit 1
            ;;
    esac
    run="$scratch/run"
fi

status=0
[ -z "$run" ] || bash docker/test-result.sh start "$run" "$results"
for step in $steps; do
    case "$step" in
        # The checks of the manifest Orca makes when it loads the plugin.
        validate) set -- bash -c '"$ORCA_CLI_COMMAND" plugin validate . && echo "orca plugin validate: манифест в порядке"' validate ;;
        # `orca plugin types` writes the typings of this Orca into .orca/ (ignored by git); tsc prints nothing when the
        # types are right, so the step says so itself: a recorded step without output is never green.
        types) set -- bash -c '"$ORCA_CLI_COMMAND" plugin types . >/dev/null && node "$1" -p . && echo "tsc: типы в порядке"' types "$tsc" ;;
        # `orca plugin test` has no filter by name: a run with --filter=… in test_args runs every test and is recorded
        # as filtered.
        plugin) set -- bash -c '"$ORCA_CLI_COMMAND" plugin test .' plugin ;;
    esac
    code=0
    if [ -n "$run" ]; then bash docker/test-result.sh step "$run" "$step" "$@"; else "$@"; fi || code=$?
    [ "$status" -ne 0 ] || status=$code
done
[ -z "$run" ] || TEST_RESULT_STEPS="$steps" bash docker/test-result.sh finish "$run" "$status"
[ -z "$scratch" ] || rm -rf "$scratch"
exit "$status"
