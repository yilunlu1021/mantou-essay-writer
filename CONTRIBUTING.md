# Contributing

Use Node.js 22 or 24 and pnpm 10.14.0. The committed runtime bundle lets users run the tool immediately. Contributors build it from the two workspace packages.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` compiles the core and writer, runs the regression suite, rebuilds the CLI and SDK bundles and tests first use. `pnpm build` creates `bin/essay.mjs`, `bin/sdk.mjs`, bundled notices and the runtime policy files. Keep the build outputs in a release commit.

The public policy sources live in `packages/essay-writer/policy`. The build copies them to `policy`. For intentional policy edits, update source versions and hashes in default.json, update the baked hash in policy-integrity.ts using the core's sorted-JSON hashValue, and add scope regression tests. An ordinary build must not silently bless changed rules. All 55 groups, including human review requirements, must remain traceable.

Source boundaries:

- `packages/text-quality`: pure policy-driven audit, measurements and edit validation.
- `packages/essay-writer`: local files, sessions, Node DOCX support and CLI.
- `scripts/build.mjs`: reproducible bundles and third-party license collection.
- `test/release.test.mjs`: bundle-only first use without workspace dependencies.

Use synthetic text for tests. Preserve prior versions and original bytes. Any format limitation that could lose content must produce a clear rejection. Add a regression for each confirmed defect. Do not turn mechanical success into delivery approval or claim detector performance.

Use Conventional Commits and a short branch. Before a release, run the native CI matrix, inspect the packaged ZIP and obtain independent review. Commit changes to code, tests, docs and generated bundles together. A changed architecture or data boundary also needs an updated explanation in README.md or SECURITY.md.
