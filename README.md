# orca-plugin-aqk

Плагин Orca для agent-queue-kit. Пока это заготовка: манифест, пустой воркер и один тест. Что плагин делает,
решат ТЗ и план MVP (`/agent-queue-start`).

## Устройство

- `orca-plugin.json` — манифест: `trusted-worker`, точка входа `src/worker.ts`.
- `src/worker.ts` — воркер плагина. Orca сама транспилирует TypeScript при загрузке: сборки нет, зависимостей во время
  работы нет.
- `src/*.test.ts` — тесты плагина на `orca/testing` (поддельный хост Orca), их запускает `orca plugin test`.
- `package.json` — только инструменты разработки (TypeScript для проверки типов).

## Разработка

```sh
npm ci                      # TypeScript в node_modules/
make test                   # манифест, типы, тесты — с записью итога для очереди агентов
orca-ide plugin dev watch . # загрузить папку в Orca, смотреть логи и перезагрузки; Ctrl-C выгружает
```

`make test` проходит три шага: `orca plugin validate .` (манифест так, как его загружает Orca), `orca plugin types .`
и `tsc -p .` (типы для этой версии Orca пишутся в `.orca/`, который git игнорирует), `orca plugin test .`. CLI Orca —
`ORCA_CLI_COMMAND` (его задают терминалы Orca), иначе `orca-ide`; голый `orca` на Linux вне Orca — экранный диктор
GNOME. Фильтра по имени теста у `orca plugin test` нет: прогон с `test_args="--compact --filter=…"` запускает все
тесты и записывается как отфильтрованный.

## Очередь агентов

Изменения идут через очередь agent-queue-kit (`CLAUDE.md`). Каждый `make test` записывает итог через
`docker/test-result.sh` (копия `reference/test-result.sh` кита) в `~/.cache/agent-queue-kit/orca-plugin-agent-queue/test-results`;
задача вливается только с полным зелёным прогоном на своём коммите. Worktree задач готовит `orca.yaml`
(`npm ci`).
