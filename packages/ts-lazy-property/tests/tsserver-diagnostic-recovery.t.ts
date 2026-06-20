// User-reported IDE flow: typo in @lazy() property type -> error -> fix type back -> error must clear.
import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, formatTsServerDiagnostics, hasTsServerDiagnostic, trimIndent } from "./util.js"
import {
    replaceSubstring,
    runTypeScriptServerSession,
    textRangeFromIndices
} from "./tsserver-util.js"

const sourceFileName   = "source.ts"
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
                hasTsServerDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                "Typo reports TS2552 on the lazy property line"
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Typo diagnostic mentions stringz: ${formatTsServerDiagnostics(typoDiagnostics)}`
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
                hasTsServerDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                `Fixed source has no lazy-property type error: ${formatTsServerDiagnostics(fixedDiagnostics)}`
            )
            t.false(
                fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Fixed source has no stale stringz diagnostic: ${formatTsServerDiagnostics(fixedDiagnostics)}`
            )
            t.false(
                fixedDiagnostics.some((diagnostic) => diagnostic.code === 2552),
                `Fixed source has no stale TS2552 anywhere: ${formatTsServerDiagnostics(fixedDiagnostics)}`
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
                hasTsServerDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                `Single-character typo reports TS2552 on the lazy property line: ${formatTsServerDiagnostics(typoDiagnostics)}`
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Single-character typo diagnostic mentions stringz: ${formatTsServerDiagnostics(typoDiagnostics)}`
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
                    hasTsServerDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                    `Fixed source has no lazy-property type error after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                    `Fixed source has no stale stringz diagnostic after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.code === 2552),
                    `Fixed source has no stale TS2552 anywhere after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
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
                `Initial valid source has no backing-property diagnostic: ${formatTsServerDiagnostics(initialDiagnostics)}`
            )
            t.false(
                initialDiagnostics.some((diagnostic) => diagnostic.code >= 2000),
                `Initial valid source has no semantic diagnostics: ${formatTsServerDiagnostics(initialDiagnostics)}`
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
                hasTsServerDiagnostic(typoDiagnostics, 2552, lazyPropertyLine),
                `Typo reports TS2552 on the lazy property line: ${formatTsServerDiagnostics(typoDiagnostics)}`
            )
            t.true(
                typoDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                `Typo diagnostic mentions stringz: ${formatTsServerDiagnostics(typoDiagnostics)}`
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
                    hasTsServerDiagnostic(fixedDiagnostics, 2552, lazyPropertyLine),
                    `Fixed source has no lazy-property type error after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("stringz")),
                    `Fixed source has no stale stringz diagnostic after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.text.includes("$lazyProperty")),
                    `Fixed source has no stale backing-property diagnostic after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
                t.false(
                    fixedDiagnostics.some((diagnostic) => diagnostic.code >= 2000),
                    `Fixed source has no semantic diagnostics after geterr #${index + 1}: ${formatTsServerDiagnostics(fixedDiagnostics)}`
                )
            }
        })
    } finally {
        await fixture.dispose()
    }
})
