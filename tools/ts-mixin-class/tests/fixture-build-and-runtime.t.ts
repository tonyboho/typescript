import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, packageRoot, runPnpm } from "./util.js"

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
