# Contributing

Thanks for taking the time to contribute to `dsh-vision-analysis`.

## Development

```sh
pnpm install          # or npm install
pnpm run typecheck    # strict TypeScript check
pnpm test             # node --test (unit + integration, no network needed)
pnpm run build        # server build (tsc)
pnpm run build:client # browser bundle (tsdown)
```

The repo is a monorepo-style single package; `src/` holds the host-side plugin
(`src/index.ts`, `src/bridge.ts`, `src/config.ts`, …) and `src/client/` the
browser half.

## Testing

Run `pnpm test` — the suite covers modes, config, media handling, the vision
client (retry/backoff/cache/failover), structured output, the image bridge
(routing, projection, fallback) and the model registry. Tests use stubbed
`fetch` and local HTTP servers; no external network or API key is required.

## Commit conventions

- Conventional-ish prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `security:`.
- Keep independent changes in separate commits.
- Update `README.md` / `README.zh.md` and `CHANGELOG.md` together with any
  user-visible behavior change.

## Pull requests

- One logical change per PR; describe what changed and why.
- If a change alters behavior, include or update a test that pins it.
- Do not add unrelated edits (the README generation rules of the upstream
  awesome list also apply to entries referencing this project).
