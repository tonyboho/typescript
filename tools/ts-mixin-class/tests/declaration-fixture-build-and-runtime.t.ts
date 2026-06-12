import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, commandOutput, packageRoot, runPnpm } from "./util.js"

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
    const negativeResult = await runPnpm(
        fixtureSuiteDirectory,
        "exec",
        "tsc",
        "-p",
        "tsconfig.required-base-negative.json"
    )

    t.true(negativeResult.exitCode !== 0, "Negative declaration required-base fixture fails to build")
    t.true(commandOutput(negativeResult).includes("does not satisfy the constraint"),
        commandOutput(negativeResult))
    t.true(commandOutput(negativeResult).includes("RequiredBase"),
        commandOutput(negativeResult))

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
