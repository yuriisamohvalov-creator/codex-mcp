# codex-cli-sync-mcp

[![npm](https://img.shields.io/npm/v/codex-cli-sync-mcp?label=npmjs.org&color=cb3837)](https://www.npmjs.com/package/codex-cli-sync-mcp)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40yuriisamohvalov--creator%2Fcodex--cli--sync--mcp-24292e?logo=github)](https://github.com/yuriisamohvalov-creator/codex-mcp/pkgs/npm/codex-cli-sync-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP-сервер, который позволяет Claude Code (или любому другому
MCP-клиенту) делегировать выполнение ограниченных задач по написанию кода
локальному [Codex CLI](https://github.com/openai/codex). Один инструмент —
`codex_execute` — синхронно запускает `codex exec --json
--skip-git-repo-check --approve-for-me -o <last-message-file> "<task>"`,
дожидается завершения и возвращает компактный отчёт: финальное сообщение
модели, `git diff --stat`, `git status --short`, код возврата и
`threadId`.

Написан по образцу `opencode-v2-mcp`/`cursor-agent-sync-mcp`: один вызов
тула блокируется до готового результата. В отличие от них, здесь не было
предыдущей рабочей MCP-обёртки для замены — существующая
`@etheaven/codex-mcp-server` построена под устаревший контракт флагов
(`--full-auto`/`--ask-for-approval` не существуют в установленной
`codex-cli 0.155.1`, вызов с `sandbox`/`fullAuto`/`approvalPolicy` падает
с `unexpected argument '--full-auto'`). Этот сервер вызывает `codex exec`
напрямую актуальными флагами, без слоя трансляции.

## Требования

- Codex CLI, установленный и авторизованный (`codex exec --version`,
  `codex login`/действующий `~/.codex/auth.json`).
- Node.js 18+.

## Установка

### Вариант 1 — из npm (рекомендуется)

Пакет опубликован как [`codex-cli-sync-mcp`](https://www.npmjs.com/package/codex-cli-sync-mcp)
— полностью публичный, ставится без авторизации:

```bash
npm install -g codex-cli-sync-mcp
```

### Вариант 2 — из исходников

```bash
git clone git@github.com:yuriisamohvalov-creator/codex-mcp.git ~/tools/codex-mcp
cd ~/tools/codex-mcp
npm install
```

### Вариант 3 — из GitHub Packages

Тот же пакет также зеркалирован в GitHub Packages под именем
[`@yuriisamohvalov-creator/codex-cli-sync-mcp`](https://github.com/yuriisamohvalov-creator/codex-mcp/pkgs/npm/codex-cli-sync-mcp).
**Важно:** в отличие от npmjs.org, GitHub Packages требует аутентификации
даже для доступа к пакету (репозиторий приватный) — понадобится `.npmrc`
со scoped-registry и GitHub-токеном с правом `read:packages`:

```bash
# ~/.npmrc или в проекте
echo "@yuriisamohvalov-creator:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm login --registry=https://npm.pkg.github.com --scope=@yuriisamohvalov-creator

npm install -g @yuriisamohvalov-creator/codex-cli-sync-mcp
```

## Подключение к Claude Code

При установке из npm (`npm install -g codex-cli-sync-mcp`) бинарник уже
в `PATH`:

```bash
claude mcp add --scope user codex -- codex-cli-sync-mcp
```

При установке из исходников:

```bash
NODE_BIN="$(which node)"
claude mcp add --scope user codex -- "$NODE_BIN" "$HOME/tools/codex-mcp/server.mjs"
```

Проверка:

```bash
claude mcp get codex
# Status: ✔ Connected
```

После подключения новой сессии Claude Code (или рестарта текущей)
инструмент доступен как `mcp__codex__codex_execute`.

**Важно про имя сервера:** если у вас уже была подключена другая
MCP-обёртка под именем `codex-cli` (например, `@etheaven/codex-mcp-server`),
регистрируйте новую **под другим именем** (как выше — `codex`), а не
переиспользуйте `codex-cli`. На практике харнесс Claude Code Desktop может
закэшировать набор тулов под старым именем сервера и не сбросить кэш даже
после нескольких полных рестартов приложения, хотя сам MCP-процесс уже
переключился на новый бинарник (дерево процессов это подтверждает).
Регистрация под новым именем обходит проблему мгновенно.

## Использование инструмента

```jsonc
{
  "task": "Add a slugify() helper in src/lib/slug.ts with tests. Acceptance: kebab-case, trims whitespace. Verify with `npm test -- slug`.",
  "cwd": "/absolute/path/to/project",
  "model": "gpt-5.1-codex",     // опционально
  "timeoutMs": 900000            // опционально, по умолчанию 15 минут
}
```

Ответ:

```jsonc
{
  "ok": true,
  "exitCode": 0,
  "threadId": "...",
  "text": "...финальное сообщение модели...",
  "diffStat": "...git diff --stat...",
  "statusShort": "...git status --short..."
}
```

## Одобрение команд

По умолчанию используется `--approve-for-me` — безопасный режим через
`workspace-write` sandbox (файловые правки и команды в пределах рабочей
директории без ручного подтверждения). Флаг `dangerouslyBypassSandbox`
переключает на `--dangerously-bypass-approvals-and-sandbox` — используйте
только в средах, уже изолированных снаружи (например, контейнер/VM без
доступа к остальной системе).

`--approve-for-me` и явный `-s/--sandbox` **нельзя комбинировать** —
`codex-cli 0.155.1` отклоняет такой вызов ошибкой; обёртка это учитывает
и не передаёт оба одновременно.

## Ограничения

- Одна задача — один синхронный запуск `codex exec`, без параллелизма
  в рамках одного вызова инструмента.
- Долгая задача блокирует вызывающую сессию на всё время выполнения —
  контролируйте через `timeoutMs`.
- Не подменяет ревью: вызывающая сторона должна самостоятельно проверять
  `diffStat`/`statusShort`, а не доверять только полю `ok`.

## Лицензия

MIT
