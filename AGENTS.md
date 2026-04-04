# Repository Guidelines

## Project Structure & Module Organization
This repository is currently a minimal scaffold (no application source files yet). Use the structure below as the default when adding code:
- `src/` - application/runtime code
- `tests/` - automated tests mirroring `src/` paths
- `assets/` - static assets (images, fixtures)
- `docs/` - design notes and architecture decisions

Example: `src/session/manager.ts` should have related tests in `tests/session/manager.test.ts`.

## Build, Test, and Development Commands
No build tooling is committed yet. When bootstrapping, prefer predictable script entry points and document them in `README.md`.

Recommended baseline commands once tooling is added:
- `npm run dev` - start local development server/watch mode
- `npm test` - run full test suite
- `npm run lint` - run static checks
- `npm run build` - create production artifacts

If another stack is chosen (for example, `make` or `just`), keep command names aligned with the same intent.

## Coding Style & Naming Conventions
- Use 2-space indentation for JS/TS/JSON/YAML.
- Use `camelCase` for variables/functions, `PascalCase` for classes/types, and `kebab-case` for file names.
- Keep modules focused; avoid files that mix unrelated responsibilities.
- Adopt a formatter/linter early (Prettier + ESLint recommended) and run it before opening a PR.

## Testing Guidelines
- Place tests under `tests/` with names ending in `.test.<ext>`.
- Prefer deterministic unit tests; isolate external/network dependencies with mocks or fixtures.
- Add regression tests for every bug fix.
- Target meaningful coverage on critical paths (session handling, terminal I/O, protocol parsing).

## Commit & Pull Request Guidelines
Git history is not initialized in this directory yet, so use Conventional Commits from the start:
- `feat: add websocket session bootstrap`
- `fix: handle terminal resize race`

PRs should include:
- concise summary of change and motivation
- linked issue/task (if available)
- test evidence (command + result)
- screenshots/log snippets for UI or terminal-behavior changes

## Security & Configuration Tips
Never commit secrets or local credentials. Keep environment-specific values in `.env.local` (ignored by Git) and provide safe defaults in `.env.example`.
