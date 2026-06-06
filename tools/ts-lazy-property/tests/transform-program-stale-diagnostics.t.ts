// Regression test for the IDE bug where fixing a regular property type (stringz -> string)
// leaves a stale TS2552 squiggle and breaks highlights. This guards the compiler-host
// side of the issue: transformed SourceFiles must not be reused when the source text
// changes before the language-service version string catches up.
import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createLazyPropertyCompilerHost } from "../src/index.js"

const sourceFileName = "source.ts"

const validSourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()

        regularProperty: string = "ok"
    }
`)

const typoSourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()

        regularProperty: stringz = "ok"
    }
`)

const regularPropertyLine = 7

it("regression: stale regular-property diagnostics when script text changes before version bumps", async (t: Test) => {
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

    const nextHost = createLazyPropertyCompilerHost(ts, compilerHost, compilerOptions, {})

    const typoProgram = ts.createProgram([ sourceFileName ], compilerOptions, nextHost)
    const typoFile    = typoProgram.getSourceFile(sourceFileName)

    if (typoFile === undefined) {
        throw new Error("Missing transformed source file.")
    }

    const typoDiagnostics = typoProgram.getSemanticDiagnostics(typoFile)

    t.true(hasDiagnostic(typoDiagnostics, 2552, regularPropertyLine), "Typo reports TS2552 on the regular property line")
    t.true(/stringz/.test(typoFile.text), "Typo transform still contains stringz before the fix")

    text = validSourceText

    const fixedProgram = ts.createProgram([ sourceFileName ], compilerOptions, nextHost)
    const fixedFile    = fixedProgram.getSourceFile(sourceFileName)

    if (fixedFile === undefined) {
        throw new Error("Missing transformed source file after the type fix.")
    }

    const fixedDiagnostics = fixedProgram.getSemanticDiagnostics(fixedFile)

    t.false(
        hasDiagnostic(fixedDiagnostics, 2552, regularPropertyLine),
        `Fixed source has no regular-property type error: ${formatDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        fixedDiagnostics.some((diagnostic) => diagnostic.messageText.toString().includes("stringz")),
        `Fixed source has no stale stringz diagnostic: ${formatDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        /stringz/.test(fixedFile.text),
        "Transformed source reflects the corrected regular property type"
    )
})

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

function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
