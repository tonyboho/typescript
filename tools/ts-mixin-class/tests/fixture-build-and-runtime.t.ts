import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, commandOutput, packageRoot, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

it("builds and runs the fixture suite with standard decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:standard"),
        "Build fixture suite with standard decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:standard"),
        "Run fixture suite with standard decorators"
    )
})

it("builds and runs the fixture suite with legacy decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:legacy"),
        "Build fixture suite with legacy decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:legacy"),
        "Run fixture suite with legacy decorators"
    )
})

it("rejects an imported required-base mixin applied to an unrelated source base", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    const result = await runPnpm(
        fixtureSuiteDirectory,
        "exec",
        "tsc",
        "-p",
        "tsconfig.required-base-negative.json"
    )

    t.true(result.exitCode !== 0, "Negative required-base source fixture fails to build")
    t.true(commandOutput(result).includes("does not satisfy the constraint"),
        commandOutput(result))
    t.true(commandOutput(result).includes("RequiredBase"),
        commandOutput(result))
})
