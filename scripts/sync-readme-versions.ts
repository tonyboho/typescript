// Syncs the version pins in the ts-mixin-class README install snippet to the
// just-bumped package version, so the documented `package.json` example never
// drifts behind the published package.
//
// Specific to ts-mixin-class on purpose: it is the only package whose README
// documents an install (it is a `ts-patch` ProgramTransformer, so the example pins
// both `ts-mixin-class` and `ts-patch`). The other packages have nothing to sync,
// so this does not iterate `packages/*` — it would only risk touching unrelated READMEs.
//
// `changeset version` bumps `packages/ts-mixin-class/package.json` but leaves the
// README example untouched. Run right after it (in the root `bump` script): set
// `"ts-mixin-class": "x.y.z"` to its current version and refresh `"ts-patch": "x.y.z"`
// to the workspace catalog version pinned in `pnpm-workspace.yaml`.
//
// Run on Node >= 23 (native TypeScript type stripping): `node scripts/sync-readme-versions.ts`.

import { readFileSync, writeFileSync } from "node:fs"

const readme: string                 = "packages/ts-mixin-class/README.md"
const pkg: { version: string }       = JSON.parse(readFileSync("packages/ts-mixin-class/package.json", "utf8"))
const tsPatch: string | undefined    = readFileSync("pnpm-workspace.yaml", "utf8").match(/"ts-patch":\s*"([^"]+)"/)?.[1]

function pin(text: string, dependency: string, version: string | undefined): string {
    return version === undefined
        ? text
        : text.replace(new RegExp(`("${dependency}":\\s*")[^"]*(")`, "g"), `$1${version}$2`)
}

const original: string = readFileSync(readme, "utf8")
const updated: string  = pin(pin(original, "ts-mixin-class", pkg.version), "ts-patch", tsPatch)

if (updated !== original) {
    writeFileSync(readme, updated)
    console.log(`synced versions in ${readme}`)
} else {
    console.log(`README versions already in sync (${readme})`)
}
