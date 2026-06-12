import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, packageRoot, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "declaration-fixture-suite")
const libraryFixtureDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

it("builds and runs the declaration fixture suite", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install declaration fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(libraryFixtureDirectory, "run", "build:standard"),
        "Build fixture suite library package"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build"),
        "Build declaration fixture consumer"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test"),
        "Run declaration fixture consumer"
    )
})
