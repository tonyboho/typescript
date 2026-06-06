import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

const execFileAsync         = promisify(execFile)
const packageRoot           = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const fixtureSuiteDirectory = path.join(packageRoot, "tests", "fixture-suite")

type CommandResult = {
    command : string,
    exitCode : number,
    stderr : string,
    stdout : string
}

type ExecFileFailure = Error & {
    code? : number | string,
    stderr? : Buffer | string,
    stdout? : Buffer | string
}

const fixtureModes = [
    {
        buildScript : "build:standard",
        name        : "standard decorators",
        testScript  : "test:standard"
    },
    {
        buildScript : "build:legacy",
        name        : "legacy decorators",
        testScript  : "test:legacy"
    }
]

it("builds and runs the fixture suite package", async (t: Test) => {
    assertSuccessfulCommand(t, await runPnpm("install"), "Install fixture suite dependencies")

    for (const fixtureMode of fixtureModes) {
        t.it(fixtureMode.name, async (t: Test) => {
            assertSuccessfulCommand(
                t,
                await runPnpm("run", fixtureMode.buildScript),
                `Build fixture suite with ${fixtureMode.name}`
            )
            assertSuccessfulCommand(
                t,
                await runPnpm("run", fixtureMode.testScript),
                `Run fixture suite with ${fixtureMode.name}`
            )
        })
    }
})

async function runPnpm(...args: string[]): Promise<CommandResult> {
    const command = [ "pnpm", ...args ].join(" ")

    try {
        const result = await execFileAsync("pnpm", args, {
            cwd : fixtureSuiteDirectory
        })

        return {
            command,
            exitCode : 0,
            stderr   : outputToString(result.stderr),
            stdout   : outputToString(result.stdout)
        }
    } catch (error) {
        const failure = error as ExecFileFailure

        return {
            command,
            exitCode : typeof failure.code === "number" ? failure.code : 1,
            stderr   : outputToString(failure.stderr || failure.message),
            stdout   : outputToString(failure.stdout)
        }
    }
}

function assertSuccessfulCommand(
    t: Test,
    result: CommandResult,
    description: string
): void {
    if (result.exitCode === 0) {
        t.pass(description)
        return
    }

    t.fail(`${description} failed with exit code ${result.exitCode}\n${commandOutput(result)}`)
}

function commandOutput(result: CommandResult): string {
    return [
        "command:",
        result.command,
        "",
        "stdout:",
        result.stdout || "<empty>",
        "",
        "stderr:",
        result.stderr || "<empty>"
    ].join("\n")
}

function outputToString(output: string | Buffer | undefined): string {
    return output?.toString() ?? ""
}
