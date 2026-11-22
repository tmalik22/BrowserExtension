# Contributing to Browser Agent

Thanks for helping out! Bug reports, model compatibility notes, docs fixes and PRs are all welcome.

## Getting set up

```bash
git clone https://github.com/tmalik22/BrowserExtension.git
cd BrowserExtension
npm install
npm run build          # builds the extension and typechecks every package
npm test               # unit + integration tests
npm run test:e2e       # real Chromium + extension + server (downloads Chromium on first run)
```

You don't need any API keys to develop or run the tests. The **mock** model profile and the scripted test models cover everything.

## Ways to help

- **Model reports.** Tried a model? Open an issue with what worked or didn't (model, server, `toolSet`, `toolMode`, `vision`). Compatibility notes for local and abliterated models are especially useful.
- **Site bugs.** If the agent can't click, read or type somewhere, a minimal HTML reproduction is gold. It can usually become a fixture in `e2e/fixtures/site`.
- **New providers** implement `Provider.complete()` (see `packages/server/src/providers/types.ts`) and convert the neutral `Turn[]` history deterministically.
- **New tool behaviour** lives in `packages/extension/src/background/executor.ts` plus a content-script handler in `packages/extension/src/content/index.ts`.

## Pull requests

1. Keep PRs focused: one fix or feature each.
2. Add or update tests. Behaviour in the browser needs an e2e test with a fixture page.
3. Run `npm run build && npm test && npm run test:e2e` before pushing. CI runs the same.
4. **Safety policy changes** (`packages/server/src/agent/policy.ts`) need tests showing both what's now allowed and what's still asked or denied.
5. If you change the side panel, refresh the README images:
   ```bash
   SHOTS=1 npx playwright test -c e2e/playwright.config.ts readme-shots
   python scripts/readme-images.py
   ```

## Code style

TypeScript strict, ES modules, no runtime dependencies in the extension. Match the surrounding code, and keep comments for the *why*.

## Security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
