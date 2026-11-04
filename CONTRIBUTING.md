# Contributing

## Setup

You need Node 24 (`.nvmrc`), git and jq. Everything below runs without building the app.

```bash
npm ci
fork/scripts/check-local.sh
```

## Before you merge

Run `fork/scripts/check-local.sh`. It runs:

- lint, typecheck, build and unit tests for the repo
- `bash -n` on the shell scripts, plus shellcheck when it's installed
- the patch series for macOS and Linux, which also checks that `fork/src` matches the patches

`check-patches.sh` needs no Mac: it only runs `git apply`, and it takes about 15 s per OS.

## CI

| Workflow | When | What |
|---|---|---|
| `ci.yml` | Every PR | One Linux job: the patch series and lint |
| `full-checks.yml` | By hand | The heavier checks, including macOS |
| `build-linux.yml`, `build-macos.yml` | By hand | Full packaged builds |
| `upstream-bump.yml` | Monthly, or by hand | Tries a newer VSCodium pin |

PR CI is deliberately small, so `check-local.sh` is what catches test and typecheck failures. Start `full-checks.yml` by hand when patches change a lot.

## Tests

- `npm test` covers the engine, the ACP client, the tact adapter and both extensions.
- `TACT_REAL_BIN=/path/to/tact npx vitest run test/real-tact.test.ts`, in `packages/tact-acp`, runs the adapter on a real tact.
- `fork/scripts/test-core.sh` and `fork/scripts/lint-core.sh` cover the core patches. They need a tree prepared with `fork/scripts/prepare-vscodium.sh`.

Tests should wait on conditions, not on the clock: a paused machine fires every timer at once. See `until` in `packages/tact-acp/test/agent.test.ts`.

## Changing core

Core changes ship as patches in [`patches/`](patches), applied after VSCodium's own. [`patches/README.md`](patches/README.md) lists them and explains how to regenerate one. New core files have readable copies in `fork/src/`, which must stay in sync.

The product name, binary and data folders live in one place: [`fork/branding.env`](fork/branding.env).

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.
