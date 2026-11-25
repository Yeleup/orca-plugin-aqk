# Agent Queue — плагин Orca (orca-plugin-aqk)

Плагин Orca «Agent Queue» (id `agent-queue`): очередь задач агентов agent-queue-kit внутри Orca. Пока это заготовка:
манифест, пустой воркер и тесты поставки. Что плагин делает, описывают ТЗ и план MVP в `docs/mvp/`.

## Требования

- Orca 1.4.273 или новее на macOS, Windows или Linux. Манифест требует эту версию (`engines.orca` — `>=1.4.273`), и
  более старая Orca плагин не загружает.
- git.
- `gh` с выполненным входом (`gh auth login`).
- Агенты из настроек проекта (например Claude Code или Codex), установленные и с выполненным входом.

## Установка

Из репозитория, CLI Orca (на Linux он называется `orca-ide`, на macOS и Windows — `orca`):

```sh
orca-ide plugin install Yeleup/orca-plugin-aqk
```

Orca ставит новейший тег версии `vX.Y.Z` (без тегов — ветку по умолчанию) и сначала показывает, какой доступ получит
плагин: `trusted-worker` — свой процесс Node.js с правами пользователя. Установка завершается той же командой с
`--approve <отпечаток>`, который Orca печатает. Когда плагин появится в каталоге Orca, его ставят и обновляют оттуда.

## Устройство

- `orca-plugin.json` — манифест: id `agent-queue`, имя «Agent Queue», `trusted-worker`, точка входа `src/worker.ts`.
- `src/worker.ts` — воркер плагина. Orca сама транспилирует TypeScript при загрузке: сборки нет, зависимостей во время
  работы нет.
- `src/*.test.ts` — тесты плагина на `orca/testing` (поддельный хост Orca), их запускает `orca plugin test`.
- `tests/*.test.mjs` — тесты поставки: манифест, подготовка worktree, `plugin inspect` чистой выгрузки коммита.
- `scripts/setup.mjs` — подготовка worktree (`setup` в `orca.yaml`).
- `package.json` — только инструменты разработки (TypeScript для проверки типов).

## Разработка

```sh
npm ci --no-audit --no-fund --no-bin-links   # подготовка: TypeScript в node_modules/, без bin-ссылок
make test                                    # манифест, типы, тесты — с записью итога для очереди агентов
orca-ide plugin dev watch .                  # загрузить папку в Orca, смотреть логи и перезагрузки; Ctrl-C выгружает
```

Подготовка ставит зависимости без bin-ссылок: ссылки npm в `node_modules/.bin` — симлинки, а `orca plugin inspect` не
принимает папку плагина с симлинком. Поэтому TypeScript запускается по пути его пакета
(`node node_modules/typescript/bin/tsc`), а не через `node_modules/.bin`. Worktree, которые создаёт Orca, готовит
`setup` из `orca.yaml` (`node scripts/setup.mjs`): он проверяет, что есть git, node, npm и CLI Orca, и делает ту же
установку. `setup` и `archive` — простые команды без синтаксиса bash: Orca запускает их через bash на macOS и Linux и
через `.cmd` на Windows.

`make test` проходит три шага: `orca plugin validate .` (манифест так, как его загружает Orca), `orca plugin types .`
и `tsc -p .` (типы для этой версии Orca пишутся в `.orca/`, который git игнорирует), `orca plugin test .` (тесты
`src/` и `tests/`). Тесты поставки берут чистую выгрузку закоммиченного HEAD, поэтому перед прогоном изменения надо
закоммитить; npm в них работает без сети, из кэша, который заполнила подготовка. CLI Orca — `ORCA_CLI_COMMAND` (его
задают терминалы Orca), иначе `orca-ide` на Linux и `orca` на macOS и Windows; голый `orca` на Linux вне Orca —
экранный диктор GNOME. Для `make test` нужны make и bash. Фильтра по имени теста у `orca plugin test` нет: прогон с
`test_args="--compact --filter=…"` запускает все тесты и записывается как отфильтрованный.

## Очередь агентов

Изменения идут через очередь agent-queue-kit (`CLAUDE.md`). Каждый `make test` записывает итог через
`docker/test-result.sh` (копия `reference/test-result.sh` кита) в `~/.cache/agent-queue-kit/orca-plugin-agent-queue/test-results`;
задача вливается только с полным зелёным прогоном на своём коммите. Worktree задач готовит `orca.yaml` (`setup`).
