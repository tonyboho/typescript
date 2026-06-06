import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createLazyPropertyCompilerHost } from "../src/index.js"
import { trimIndent } from "./util.js"

const sourceFileName = "source.ts"
const lazyPropertyLine = 5
const regularPropertyLine = 7

const validSourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()

        regularProperty: string = "ok"
    }
`)

const lazyTypeTypoSourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, stringz> = new Map()

        regularProperty: string = "ok"
    }
`)

const regularTypeTypoSourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()

        regularProperty: stringz = "ok"
    }
`)

it("does not reuse stale transformed source when a lazy property type changes before version bumps", async (t: Test) => {
    const { fixedDiagnostics, fixedFile, typoDiagnostics } = runStaleVersionFlow(lazyTypeTypoSourceText, validSourceText)

    t.true(
        hasDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
        "Typo reports TS2552 on the lazy property line"
    )
    assertFixedSource(t, fixedFile, fixedDiagnostics, lazyPropertyLine, "lazy-property")
})

it("does not reuse stale transformed source when a regular property type changes before version bumps", async (t: Test) => {
    const { fixedDiagnostics, fixedFile, typoDiagnostics } = runStaleVersionFlow(regularTypeTypoSourceText, validSourceText)

    t.true(
        hasDiagnostic(typoDiagnostics, 2552, regularPropertyLine),
        "Typo reports TS2552 on the regular property line"
    )
    assertFixedSource(t, fixedFile, fixedDiagnostics, regularPropertyLine, "regular-property")
})

function runStaleVersionFlow(
    typoSourceText: string,
    fixedSourceText: string
): {
    fixedDiagnostics : readonly ts.Diagnostic[],
    fixedFile : ts.SourceFile,
    typoDiagnostics : readonly ts.Diagnostic[]
} {
    let text = typoSourceText

    const compilerOptions = {
        target                 : ts.ScriptTarget.ES2022,
        module                 : ts.ModuleKind.ESNext,
        moduleResolution       : ts.ModuleResolutionKind.Bundler,
        strict                 : true,
        skipLibCheck           : true,
        noEmit                 : true,
        experimentalDecorators : false
    }
    const compilerHost = ts.createCompilerHost(compilerOptions, true)
    const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost)

    compilerHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (fileName.endsWith(sourceFileName)) {
            const sourceFile = ts.createSourceFile(
                sourceFileName,
                text,
                ts.ScriptTarget.ES2022,
                true,
                ts.ScriptKind.TS
            )

            ;(sourceFile as ts.SourceFile & { version?: string }).version = "1"

            return sourceFile
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    const nextHost        = createLazyPropertyCompilerHost(ts, compilerHost, compilerOptions, {})
    const typoProgram     = ts.createProgram([ sourceFileName ], compilerOptions, nextHost)
    const typoFile        = requireSourceFile(typoProgram, "Missing transformed source file.")
    const typoDiagnostics = typoProgram.getSemanticDiagnostics(typoFile)

    text = fixedSourceText

    const fixedProgram = ts.createProgram([ sourceFileName ], compilerOptions, nextHost)
    const fixedFile    = requireSourceFile(fixedProgram, "Missing transformed source file after the type fix.")

    return {
        fixedDiagnostics : fixedProgram.getSemanticDiagnostics(fixedFile),
        fixedFile,
        typoDiagnostics
    }
}

function assertFixedSource(
    t: Test,
    fixedFile: ts.SourceFile,
    fixedDiagnostics: readonly ts.Diagnostic[],
    diagnosticLine: number,
    label: string
): void {
    t.false(
        hasDiagnostic(fixedDiagnostics, 2552, diagnosticLine),
        `Fixed source has no ${label} type error: ${formatDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        fixedDiagnostics.some((diagnostic) => diagnostic.messageText.toString().includes("stringz")),
        `Fixed source has no stale stringz diagnostic: ${formatDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        /stringz/.test(fixedFile.text),
        `Transformed source reflects the corrected ${label} type`
    )
}

function requireSourceFile(program: ts.Program, message: string): ts.SourceFile {
    const sourceFile = program.getSourceFile(sourceFileName)

    if (sourceFile === undefined) {
        throw new Error(message)
    }

    return sourceFile
}

function hasDiagnostic(
    diagnostics: readonly ts.Diagnostic[],
    code: number,
    line: number
): boolean {
    return diagnostics.some((diagnostic) => {
        if (diagnostic.file === undefined || diagnostic.start === undefined) {
            return false
        }

        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)

        return diagnostic.code === code && position.line + 1 === line
    })
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
    return diagnostics.map((diagnostic) => {
        const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)

        return [
            `TS${diagnostic.code}`,
            position === undefined ? "?:?" : `${position.line + 1}:${position.character + 1}`,
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ].join(" ")
    }).join("\n")
}
