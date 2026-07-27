# Contributing to mycadre

Thanks for considering a contribution! `mycadre` is a small, focused CLI, and
we'd like to keep it that way — please open an issue to discuss larger changes
before sending a PR.

## Local development

Requires Node.js >= 18 and `git` on your PATH.

```sh
git clone https://github.com/flossypurse-studios/mycadre.git
cd mycadre
npm install
npm run build   # compiles TypeScript (src -> dist) via tsc
npm test        # runs the test suite (node --test)
```

Useful during development:

```sh
npm run dev -- <args>   # run the CLI directly from src/ via ts-node, no build step
```

## Making a change

1. Fork the repo and create a branch for your change.
2. Make your change with tests where it makes sense (see `test/` or files
   colocated with `.test.ts` suffixes).
3. Run `npm run build` and `npm test` and make sure both pass cleanly.
4. Open a pull request describing what changed and why. Link any related issue.

## Reporting bugs / requesting features

Please open a GitHub issue with:
- What you expected to happen vs. what happened.
- Your OS, Node version, and `mycadre.json` config (redact anything sensitive).
- Steps to reproduce, if it's a bug.

## Code style

The codebase is plain TypeScript compiled with `tsc` — no extra formatter/linter
config beyond what's in `tsconfig.json`. Keep changes minimal and consistent
with the surrounding code.

## License

By contributing, you agree your contributions will be licensed under the
project's MIT license.
