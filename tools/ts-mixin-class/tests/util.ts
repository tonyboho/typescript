import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import ts from "typescript"
import type { Test } from "@bryntum/siesta/nodejs.js"

// dist/tests/util.js -> корень пакета
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const execFileAsync = promisify(execFile)

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

export function createSourceFile(text: string): ts.SourceFile {
    return ts.createSourceFile(
        "source.ts",
        trimIndent(text),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
}

export function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}

export function findFirst<Node extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is Node
): Node | undefined {
    let found: Node | undefined

    const visit = (node: ts.Node): void => {
        if (found !== undefined) {
            return
        }

        if (predicate(node)) {
            found = node
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(root)

    return found
}

// Полноценный тайпчек текста как модуля, импортирующего "ts-mixin-class":
// пакет резолвится в локальный src/index.ts, остальное — обычный node resolution
export function typecheckText(text: string): string[] {
    const virtualFileName = path.join(packageRoot, "typecheck-virtual-test.ts")

    const options: ts.CompilerOptions = {
        strict                  : true,
        target                  : ts.ScriptTarget.ES2022,
        module                  : ts.ModuleKind.NodeNext,
        moduleResolution        : ts.ModuleResolutionKind.NodeNext,
        useDefineForClassFields : false,
        noEmit                  : true,
        skipLibCheck            : true,
        types                   : [ "node" ]
    }

    const host = ts.createCompilerHost(options)

    const originalGetSourceFile = host.getSourceFile.bind(host)
    const originalFileExists    = host.fileExists.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (path.resolve(fileName) === virtualFileName) {
            return ts.createSourceFile(virtualFileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    host.fileExists = (fileName) => {
        return path.resolve(fileName) === virtualFileName || originalFileExists(fileName)
    }

    host.resolveModuleNameLiterals = (moduleLiterals, containingFile, _redirectedReference, compilerOptions) => {
        return moduleLiterals.map((literal) => {
            if (literal.text === "ts-mixin-class") {
                return {
                    resolvedModule : {
                        resolvedFileName        : path.join(packageRoot, "src", "index.ts"),
                        extension               : ts.Extension.Ts,
                        isExternalLibraryImport : false
                    }
                }
            }

            return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
        })
    }

    const program = ts.createProgram([ virtualFileName ], options, host)

    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
        const message  = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        const location = diagnostic.file !== undefined && diagnostic.start !== undefined
            ? `(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1})`
            : ""

        return `TS${diagnostic.code}${location}: ${message}`
    })
}

function outputToString(output: string | Buffer | undefined): string {
    return output?.toString() ?? ""
}
