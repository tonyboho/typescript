import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Test } from "@bryntum/siesta/nodejs.js"

const execFileAsync = promisify(execFile)

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export type TypeScriptFixtureOptions = {
    sourceFiles : TypeScriptFixtureSourceFile[],
    experimentalDecorators : boolean,
    compilerOptions? : Record<string, unknown>,
    compilerPlugins? : Record<string, unknown>[],
    keep? : boolean
}

export type TypeScriptFixtureSourceFile = {
    fileName : string,
    text : string,
}

export type TypeScriptFixture = {
    directory : string,
    outputFiles : Map<string, string>,
    packageJsonFile : string,
    sourceFiles : Map<string, string>,
    tsconfigFile : string,
    build : () => Promise<TypeScriptFixtureCommandResult>,
    dispose : () => Promise<void>,
    runSiesta : (sourceFileName: string) => Promise<TypeScriptFixtureCommandResult>,
    typecheck : () => Promise<TypeScriptFixtureCommandResult>
}

export type TypeScriptFixtureCommandResult = CommandResult

export type CommandResult = {
    command : string,
    exitCode : number,
    stdout : string,
    stderr : string,
}

type ExecFileFailure = Error & {
    code? : number | string,
    stdout? : string | Buffer,
    stderr? : string | Buffer,
}

export async function createTypeScriptFixture(options: TypeScriptFixtureOptions): Promise<TypeScriptFixture> {
    const directory       = await mkdtemp(path.join(tmpdir(), "ts-lazy-property-"))
    const packageJsonFile = path.join(directory, "package.json")
    const tsconfigFile    = path.join(directory, "tsconfig.json")
    const sourceFilePaths = new Map(options.sourceFiles.map(({ fileName }) => [ fileName, path.join(directory, fileName) ]))
    const outputFiles     = new Map(options.sourceFiles.map(({ fileName }) => [ fileName, outputFileName(directory, fileName) ]))

    await writeJson(packageJsonFile, createPackageJson())
    await writeJson(tsconfigFile, createTsconfig(
        options.sourceFiles.map(({ fileName }) => fileName),
        options.experimentalDecorators,
        options.compilerOptions,
        options.compilerPlugins
    ))

    for (const { fileName, text } of options.sourceFiles) {
        const sourceFilePath = path.join(directory, fileName)

        await mkdir(path.dirname(sourceFilePath), { recursive : true })
        await writeFile(sourceFilePath, text)
    }

    await linkNodeModules(directory)

    return {
        directory,
        outputFiles,
        packageJsonFile,
        sourceFiles : sourceFilePaths,
        tsconfigFile,

        async build() {
            return runTypeScriptCompiler(directory, tsconfigFile, false)
        },

        async dispose() {
            if (options.keep) {
                return
            }

            await rm(directory, { force : true, recursive : true })
        },

        async runSiesta(sourceFileName: string) {
            const testFile = outputFiles.get(sourceFileName)

            if (testFile === undefined) {
                throw new Error(`Unknown fixture source file: ${sourceFileName}`)
            }

            return runSiesta(directory, testFile)
        },

        async typecheck() {
            return runTypeScriptCompiler(directory, tsconfigFile, true)
        }
    }
}

function createPackageJson(): unknown {
    return {
        name    : "ts-lazy-property-fixture",
        private : true,
        type    : "module"
    }
}

async function runTypeScriptCompiler(
    directory: string,
    tsconfigFile: string,
    noEmit: boolean
): Promise<TypeScriptFixtureCommandResult> {
    return runCommand(
        process.execPath,
        [
            path.join(packageRoot, "node_modules/typescript/bin/tsc"),
            "-p",
            tsconfigFile,
            ...(noEmit ? [ "--noEmit" ] : [])
        ],
        directory
    )
}

async function runSiesta(directory: string, testFile: string): Promise<TypeScriptFixtureCommandResult> {
    return runCommand(
        process.execPath,
        [
            testFile
        ],
        directory
    )
}

export async function runPnpm(
    cwd: string,
    ...args: string[]
): Promise<CommandResult> {
    return runCommand("pnpm", args, cwd)
}

export async function runCommand(
    executable: string,
    args: string[],
    cwd: string
): Promise<CommandResult> {
    const command = [ executable, ...args ].join(" ")

    try {
        const result = await execFileAsync(executable, args, { cwd })

        return {
            command,
            exitCode : 0,
            stdout   : outputToString(result.stdout),
            stderr   : outputToString(result.stderr)
        }
    } catch (error) {
        const failure = error as ExecFileFailure

        return {
            command,
            exitCode : typeof failure.code === "number" ? failure.code : 1,
            stdout   : outputToString(failure.stdout),
            stderr   : outputToString(failure.stderr || failure.message)
        }
    }
}

export function assertSuccessfulCommand(
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

export function commandOutput(result: CommandResult): string {
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

function createTsconfig(
    sourceFileNames: string[],
    experimentalDecorators: boolean,
    compilerOptions: Record<string, unknown> | undefined,
    compilerPlugins: Record<string, unknown>[] | undefined
): unknown {
    const {
        plugins : compilerOptionPlugins,
        ...restCompilerOptions
    } = compilerOptions ?? {}
    const extraCompilerOptionPlugins = Array.isArray(compilerOptionPlugins) ? compilerOptionPlugins : []

    return {
        compilerOptions : {
            target                  : "ES2022",
            module                  : "ESNext",
            moduleResolution        : "Bundler",
            lib                     : [ "ES2022", "DOM" ],
            useDefineForClassFields : false,
            skipLibCheck            : true,
            outDir                  : "dist",
            plugins                 : [
                {
                    transform        : "ts-lazy-property",
                    transformProgram : true
                },
                ...(compilerPlugins ?? []),
                ...extraCompilerOptionPlugins
            ],
            ...restCompilerOptions,
            strict                  : true,
            experimentalDecorators
        },
        files : sourceFileNames
    }
}

function outputFileName(directory: string, sourceFileName: string): string {
    return path.join(directory, "dist", sourceFileName.replace(/\.[cm]?tsx?$/, ".js"))
}

async function linkNodeModules(directory: string): Promise<void> {
    const nodeModules  = path.join(directory, "node_modules")
    const bryntumScope = path.join(nodeModules, "@bryntum")

    await mkdir(nodeModules, { recursive : true })
    await mkdir(bryntumScope, { recursive : true })
    await symlink(packageRoot, path.join(nodeModules, "ts-lazy-property"), "dir")
    await symlink(path.join(packageRoot, "node_modules/typescript"), path.join(nodeModules, "typescript"), "dir")
    await symlink(path.join(packageRoot, "node_modules/@bryntum/siesta"), path.join(bryntumScope, "siesta"), "dir")
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
    await writeFile(fileName, `${JSON.stringify(value, null, 4)}\n`)
}

function outputToString(output: string | Buffer | undefined): string {
    return output?.toString() ?? ""
}

export function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
