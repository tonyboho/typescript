// User-reported IDE flow: typo in @lazy() property type -> error -> fix type back -> error must clear.
import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createLazyPropertyCompilerHost } from "../src/index.js"
import { createTypeScriptFixture } from "./util.js"
import {
    replaceSubstring,
    runTypeScriptServerSession,
    textRangeFromIndices,
    type TsServerDiagnostic
} from "./tsserver-util.js"

const sourceFileName = "source.ts"
const lazyPropertyLine = 5

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
        lazyProperty: Map<number, stringz> = new Map()

        regularProperty: string = "ok"
    }
`)

const validSourceTextWithBackingUsage = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()
    }

    const instance = new SourceClass()

    instance.$lazyProperty
`)

it("tsserver clears a lazy property type error after the type name is fixed in place", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : sourceFileName,
                text     : validSourceText
            }
        ]
    })

    try {
        const sourceFile = fixture.sourceFiles.get(sourceFileName)

        if (sourceFile === undefined) {
            throw new Error("Missing fixture source file.")
        }

        await runTypeScriptServerSession(fixture.directory, async (session) => {
            await session.open({
                file            : sourceFile,
                fileContent     : typoSourceText,
                projectRootPath : fixture.directory
            })

            const typoDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.true(
                hasDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                "Typo reports TS2552 on the lazy property line"
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Typo diagnostic mentions stringz: ${formatDiagnostics(typoDiagnostics)}`
            )

            const { end, nextSource, start } = replaceSubstring(
                typoSourceText,
                "Map<number, stringz>",
                "Map<number, string>"
            )

            await session.change({
                file         : sourceFile,
                insertString : "Map<number, string>",
                ...textRangeFromIndices(typoSourceText, start, end)
            })

            const fixedDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.false(
                hasDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                `Fixed source has no lazy-property type error: ${formatDiagnostics(fixedDiagnostics)}`
            )
            t.false(
                fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Fixed source has no stale stringz diagnostic: ${formatDiagnostics(fixedDiagnostics)}`
            )
            t.false(
                fixedDiagnostics.some((diagnostic) => diagnostic.code === 2552),
                `Fixed source has no stale TS2552 anywhere: ${formatDiagnostics(fixedDiagnostics)}`
            )

            t.equal(nextSource, validSourceText, "Editor fix restores the valid source text")
        })
    } finally {
        await fixture.dispose()
    }
})

it("tsserver clears a lazy property type error after single-character editor edits", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : sourceFileName,
                text     : validSourceText
            }
        ]
    })

    try {
        const sourceFile = fixture.sourceFiles.get(sourceFileName)

        if (sourceFile === undefined) {
            throw new Error("Missing fixture source file.")
        }

        await runTypeScriptServerSession(fixture.directory, async (session) => {
            await session.open({
                file            : sourceFile,
                fileContent     : validSourceText,
                projectRootPath : fixture.directory
            })

            const insertionIndex = validSourceText.indexOf("string>") + "string".length
            const insertionPoint = textRangeFromIndices(validSourceText, insertionIndex, insertionIndex)

            await session.change({
                file         : sourceFile,
                insertString : "z",
                ...insertionPoint
            })

            const typoDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.true(
                hasDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                `Single-character typo reports TS2552 on the lazy property line: ${formatDiagnostics(typoDiagnostics)}`
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Single-character typo diagnostic mentions stringz: ${formatDiagnostics(typoDiagnostics)}`
            )

            const typoText     = `${validSourceText.slice(0, insertionIndex)}z${validSourceText.slice(insertionIndex)}`
            const deletionSpan = textRangeFromIndices(typoText, insertionIndex, insertionIndex + 1)

            await session.change({
                file         : sourceFile,
                insertString : "",
                ...deletionSpan
            })

            for (let index = 0; index < 3; index += 1) {
                const fixedDiagnostics = await session.getDiagnostics([ sourceFile ])

                t.false(
                    hasDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                    `Fixed source has no lazy-property type error after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                    `Fixed source has no stale stringz diagnostic after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.code === 2552),
                    `Fixed source has no stale TS2552 anywhere after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
            }
        })
    } finally {
        await fixture.dispose()
    }
})

it("tsserver clears backing property access diagnostics after a lazy type typo is fixed", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : sourceFileName,
                text     : validSourceTextWithBackingUsage
            }
        ]
    })

    try {
        const sourceFile = fixture.sourceFiles.get(sourceFileName)

        if (sourceFile === undefined) {
            throw new Error("Missing fixture source file.")
        }

        await runTypeScriptServerSession(fixture.directory, async (session) => {
            await session.open({
                file            : sourceFile,
                fileContent     : validSourceTextWithBackingUsage,
                projectRootPath : fixture.directory
            })

            const initialDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.false(
                initialDiagnostics.some((diagnostic) => diagnostic.text.includes("$lazyProperty")),
                `Initial valid source has no backing-property diagnostic: ${formatDiagnostics(initialDiagnostics)}`
            )
            t.false(
                initialDiagnostics.some((diagnostic) => diagnostic.code >= 2000),
                `Initial valid source has no semantic diagnostics: ${formatDiagnostics(initialDiagnostics)}`
            )

            const insertionIndex = validSourceTextWithBackingUsage.indexOf("string>") + "string".length
            const insertionPoint = textRangeFromIndices(validSourceTextWithBackingUsage, insertionIndex, insertionIndex)

            await session.change({
                file         : sourceFile,
                insertString : "z",
                ...insertionPoint
            })

            const typoDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.true(
                hasDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                `Typo reports TS2552 on the lazy property line: ${formatDiagnostics(typoDiagnostics)}`
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Typo diagnostic mentions stringz: ${formatDiagnostics(typoDiagnostics)}`
            )

            const typoText     = `${validSourceTextWithBackingUsage.slice(0, insertionIndex)}z${validSourceTextWithBackingUsage.slice(insertionIndex)}`
            const deletionSpan = textRangeFromIndices(typoText, insertionIndex, insertionIndex + 1)

            await session.change({
                file         : sourceFile,
                insertString : "",
                ...deletionSpan
            })

            for (let index = 0; index < 3; index += 1) {
                const fixedDiagnostics = await session.getDiagnostics([ sourceFile ])

                t.false(
                    hasDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                    `Fixed source has no lazy-property type error after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                    `Fixed source has no stale stringz diagnostic after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("$lazyProperty")),
                    `Fixed source has no stale backing-property diagnostic after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.code >= 2000),
                    `Fixed source has no semantic diagnostics after geterr #${index + 1}: ${formatDiagnostics(fixedDiagnostics)}`
                )
            }
        })
    } finally {
        await fixture.dispose()
    }
})

it("regression: stale lazy-property diagnostics when script text changes before version bumps", async (t: Test) => {
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

    t.true(
        hasProgramDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
        "Typo reports TS2552 on the lazy property line"
    )
    t.true(/stringz/.test(typoFile.text), "Typo transform still contains stringz before the fix")

    text = validSourceText

    const fixedProgram = ts.createProgram([ sourceFileName ], compilerOptions, nextHost)
    const fixedFile    = fixedProgram.getSourceFile(sourceFileName)

    if (fixedFile === undefined) {
        throw new Error("Missing transformed source file after the type fix.")
    }

    const fixedDiagnostics = fixedProgram.getSemanticDiagnostics(fixedFile)

    t.false(
        hasProgramDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
        `Fixed source has no lazy-property type error: ${formatProgramDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        fixedDiagnostics.some((diagnostic) => diagnostic.messageText.toString().includes("stringz")),
        `Fixed source has no stale stringz diagnostic: ${formatProgramDiagnostics(fixedDiagnostics)}`
    )
    t.false(
        /stringz/.test(fixedFile.text),
        "Transformed source reflects the corrected lazy property type"
    )
})

function hasDiagnostic(
    diagnostics: TsServerDiagnostic[],
    code: number,
    line: number
): boolean {
    return diagnostics.some((diagnostic) => {
        return diagnostic.code === code && diagnostic.start.line === line
    })
}

function hasProgramDiagnostic(
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

function formatDiagnostics(diagnostics: TsServerDiagnostic[]): string {
    return diagnostics.map((diagnostic) => {
        return `TS${diagnostic.code} ${diagnostic.start.line}:${diagnostic.start.offset} ${diagnostic.text}`
    }).join("\n")
}

function formatProgramDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
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
