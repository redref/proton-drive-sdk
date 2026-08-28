# Proton Drive CLI agent instructions

These instructions apply to all work under `cli/`.

## Required workflow

1. Read the affected implementation and its nearest tests before editing.
2. Keep changes inside `cli/` unless the requested behavior cannot be implemented through the public SDK APIs.
3. Add or update focused, colocated tests for behavioral changes and bug fixes.
4. Run the narrowest relevant test first, then type-check and lint from `cli/`.
5. Run the full CI-style test suite when changing shared parsing, paths, initialization, credentials, events, caches, telemetry, or transfer infrastructure.
6. Report the checks run and any checks not run.

Use these commands from `cli/`:

- Focused test: `bun run test -- path/to/file.test.ts`
- Tests: `bun run test`
- CI-style tests: `bun run test:ci`
- Type-check: `bun run check-types`
- Lint: `bun run lint`
- Build: `bun run build`
- Bundle only: `bun run build:bundle`

Do not run `bun run pretty` unless broad formatting is explicitly intended; it rewrites every TypeScript file under `src`.

## Scope and generated files

- Do not edit `node_modules/`, `release/`, `dist/`, or `src/telemetry/metrics/types/*.schema.d.ts`.
- Do not modify `bun.lock` unless dependencies intentionally change.
- Preserve unrelated working-tree changes.
- If a CLI change requires editing `client/js` or `incubating/account/js`, explain why the CLI cannot use the current public API before expanding scope.

## Architecture invariants

- `src/proton-drive.ts` is the executable entry point and build-time configuration boundary.
- `src/init.ts` owns dependency composition. Commands receive dependencies through `ActionArgs`; they must not initialize SDK clients, credentials, caches, events, or telemetry themselves.
- User-facing commands implement `Command` from `src/cli/interface.ts` and are registered in `src/commands/registry.ts`.
- Remote Drive paths always use POSIX semantics, including on Windows. Use `Paths` and `PathType` for remote resolution and scope validation.
- Keep local filesystem paths and remote Drive paths conceptually and programmatically distinct.
- Preserve the existing top-level error classification and exit-code behavior.

## Command behavior

For a new command, normally provide:

1. A `Command...` class in the appropriate `src/commands/<group>/` directory.
2. `group`, `name`, `help`, positional `args`, and command-specific `options`.
3. An async `action()` accepting `ActionArgs`.
4. Registration in `src/commands/registry.ts`.
5. Focused tests for parsing, validation, formatting, and side effects.
6. User documentation when the public interface changes.

Default `--help`, `--json`, and `--verbose` options are added centrally. Do not redefine them in individual commands.

- Throw `ValidationError` for invalid user input and unsupported user operations.
- Keep `--json` output stable and machine-readable. It must not contain prompts, progress UI, or incidental logs.
- Sanitize remote and user-provided text before writing it to a terminal.
- Stream SDK async iterators when possible instead of collecting entire result sets in memory.
- Non-interactive and JSON operation must not wait for interactive input; require explicit options where necessary.
- User-visible interface changes may require updates to `README.md` and `CHANGELOG.md`; decide based on release impact rather than updating them mechanically.

## Transfers

Upload and download changes must preserve:

- bounded concurrency and backpressure;
- streaming rather than whole-file buffering;
- conflict strategy semantics;
- progress pause, resume, and cleanup behavior;
- final summary output on both success and failure;
- partial-failure reporting;
- JSON-mode suppression of interactive UI.

Exercise particular care with closures around file buffers and streams: progress callbacks must not unnecessarily retain large encrypted or plaintext buffers.

## Security and privacy

- Never print passwords, authentication tokens, credential records, encryption keys, or raw sessions.
- Do not introduce plaintext credential persistence except through the explicitly named unsafe testing store.
- Do not weaken cache encryption or secret-store behavior.
- Treat filenames and server-provided strings as untrusted terminal input.
- Telemetry must not contain credentials, file contents, filenames, or full local paths.
- Preserve both the build-time and user-preference gates for telemetry and metrics.

## TypeScript and tests

- Preserve strict TypeScript typing and avoid introducing `any`.
- Follow the import ordering enforced by ESLint.
- Place unit tests beside their source as `*.test.ts`.
- Prefer isolated tests with mocked SDK boundaries over live API access.
- Unit tests must not require a Proton account, network access, browser login, an OS keychain, or a real password store.
- Add regression coverage for bug fixes.

Cover the relevant edge cases for the change, especially:

- missing or malformed arguments;
- supported and unsupported `PathType` values;
- JSON versus human-readable output;
- authentication requirements;
- async iterator and partial transfer failures;
- conflict resolution and resource cleanup;
- platform-specific local path behavior;
- untrusted terminal text.
