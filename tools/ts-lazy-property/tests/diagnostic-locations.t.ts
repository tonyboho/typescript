import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import { trimIndent } from "./util.js"

const sourceFileName = "source.ts"
const sourceText     = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: string = 1
    }
`)

it("reports lazy initializer diagnostics at the original source property position", async (t: Test) => {
    const sourceFile  = createSourceFile(sourceText)
    const diagnostics = getSemanticDiagnostics(sourceFile)
    const typeError   = diagnostics.find((diagnostic) => diagnostic.code === 2322)

    if (typeError === undefined || typeError.start === undefined) {
        t.fail(`Cannot find TS2322 diagnostic: ${formatDiagnostics(sourceFile, diagnostics)}`)
        return
    }

    const position = sourceFile.getLineAndCharacterOfPosition(typeError.start)
    const highlightedText = sourceFile.text.slice(typeError.start, typeError.start + (typeError.length ?? 0))

    t.equal(ts.flattenDiagnosticMessageText(typeError.messageText, "\n"), "Type 'number' is not assignable to type 'string'.")
    t.equal(position.line + 1, 5, "Diagnostic points at the original lazy property line")
    t.equal(position.character + 1, 5, "Diagnostic points at the original lazy property declaration start")
    t.true(highlightedText.startsWith("lazyProperty"), "Diagnostic highlight starts at the lazy property declaration")
    t.false(highlightedText.startsWith("@"), "Diagnostic highlight does not start at the lazy decorator")
})

function getSemanticDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
    const compilerOptions = {
        target           : ts.ScriptTarget.ES2022,
        module           : ts.ModuleKind.ESNext,
        moduleResolution : ts.ModuleResolutionKind.Bundler,
        strict           : true,
        noEmit           : true,
        skipLibCheck     : true,
        lib              : [ "lib.es2022.d.ts", "lib.dom.d.ts" ]
    }
    const transformedSourceFile = transformSourceFile(ts, sourceFile, {
        preserveLazyDecorator : true
    })
    const host = ts.createCompilerHost(compilerOptions, true)
    const getSourceFile = host.getSourceFile.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (fileName === sourceFileName) {
            return transformedSourceFile
        }

        return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    const program = ts.createProgram([ sourceFileName ], compilerOptions, host)

    return program.getSemanticDiagnostics(program.getSourceFile(sourceFileName))
}

function createSourceFile(text: string): ts.SourceFile {
    return ts.createSourceFile(
        sourceFileName,
        text,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
    )
}

function formatDiagnostics(sourceFile: ts.SourceFile, diagnostics: readonly ts.Diagnostic[]): string {
    return diagnostics.map((diagnostic) => {
        const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)

        return [
            `TS${diagnostic.code}`,
            `${position.line + 1}:${position.character + 1}`,
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ].join(" ")
    }).join("\n")
}
