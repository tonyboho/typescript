import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import type { TypeScriptFixtureCommandResult } from "./util.js"

const packageRoot      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const fixturesDirectory = path.join(packageRoot, "tests", "fixture")

it("runs fixture tests", async (t: Test) => {
    const fixtureNames = (await readdir(fixturesDirectory))
        .filter((fileName) => fileName.endsWith(".ts"))
        .sort()

    const fixture = await createTypeScriptFixture({
        sourceFiles : await Promise.all(fixtureNames.map(async (fixtureName) => {
            return {
                fileName : fixtureName,
                text     : await readFile(path.join(fixturesDirectory, fixtureName), "utf8")
            }
        }))
    })

    try {
        const buildResult = await fixture.build()

        assertSuccessfulCommand(t, buildResult, "Build fixtures")

        if (buildResult.exitCode !== 0) {
            return
        }

        for (const fixtureName of fixtureNames) {
            await t.subTest(fixtureName, async (t: Test) => {
                assertSuccessfulCommand(t, await fixture.runSiesta(fixtureName), "Run fixture tests")
            })
        }
    } finally {
        await fixture.dispose()
    }
})

function assertSuccessfulCommand(
    t: Test,
    result: TypeScriptFixtureCommandResult,
    description: string
): void {
    if (result.exitCode === 0) {
        t.pass(description)
        return
    }

    t.fail(`${description} failed with exit code ${result.exitCode}\n${commandOutput(result)}`)
}

function commandOutput(result: TypeScriptFixtureCommandResult): string {
    return [
        "stdout:",
        result.stdout || "<empty>",
        "",
        "stderr:",
        result.stderr || "<empty>"
    ].join("\n")
}
