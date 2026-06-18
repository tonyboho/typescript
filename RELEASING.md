# Releasing

Releases are driven [Changesets](https://github.com/changesets/changesets) and run
**locally from `main`**. The monorepo uses a single release process: you bump whatever
packages have pending changesets, then publish — and `changeset publish` only pushes the
packages whose version is **ahead of the npm registry**. So bumping one package releases
just that package; the others are skipped automatically, with no per-package wiring.

## 1. Describe each change with a changeset

On a feature branch, for every user-facing change:

```sh
pnpm changeset
```

This interactive prompt asks which package(s) changed and the bump type
(`patch` / `minor` / `major`), and writes a markdown file under `.changeset/`. Commit it
with the change. Test-only or internal changes do not need a changeset.

## 2. Version the packages

On an up-to-date `main`:

```sh
pnpm bump
```

This runs `changeset version` (consumes the pending changesets, bumps versions, writes
`CHANGELOG.md`) and then dates the new changelog heading. Review the version bump and
changelog, trim the entries if needed, and commit:

```sh
git commit -am "chore: release <package> <version>"
```

## 3. Publish

```sh
pnpm release
```

This runs, in order:

1. `release:preflight` — asserts you are on a clean `main`, not behind `origin/main`, with
   no leftover changesets (i.e. step 2 was done and committed).
2. `release:check` — `clean → typecheck → build → lint:check → test → publint → attw`
   across every package. The full gate runs even when only one package is being
   published; a red check aborts before anything is published.
3. `changeset publish` — publishes every package whose version is ahead of the registry
   and creates the matching git tag(s). `npm` may prompt for an OTP if 2FA is enabled.
4. `git push --follow-tags` — pushes the release commit and tags.

Requires an `npm login` with publish rights to the packages.

## Notes

- **Why does one package release on its own?** `changeset publish` diffs each package's
  local version against the registry and skips anything already published. There is no
  per-package release command — that would be a workaround for what the tool already does.
- **A package not yet ready to publish** should be `"private": true` in its `package.json`:
  Changesets still versions it and writes its changelog, but never publishes it. Flip the
  flag off when it is ready to ship.
