import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import {
    positionToLineOffset,
    runTypeScriptServerRequest,
    runTypeScriptServerSession,
    textRangeFromIndices
} from "./tsserver-util.js"
import type { TsServerResponse } from "./tsserver-util.js"

type TextPosition = {
    line : number,
    offset : number
}

type TextSpan = {
    start : TextPosition,
    end : TextPosition
}

type DefinitionInfo = TextSpan & {
    file : string
}

type QuickInfoBody = TextSpan & {
    displayString? : string
}

type ReferencesBody = {
    refs? : Array<TextSpan & {
        file : string,
        isDefinition? : boolean
    }>
}

type DocumentHighlightsBody = Array<{
    file : string,
    highlightSpans : TextSpan[]
}>

const sourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()
    }

    const instance = new SourceClass()

    instance.lazyProperty.set(1, "one")
    instance.lazyProperty
    instance.$lazyProperty
`)

it("tsserver definition resolves lazy property usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const response = await request(sourceFile, "definition", publicUsageArgs(sourceFile))
        const definitions = assertResponseBody<DefinitionInfo[]>(t, response)

        t.true(definitions.some((definition) => {
            return definition.file === sourceFile &&
                sourceSlice(sourceText, definition) === "lazyProperty" &&
                definition.start.line === 5
        }), "Public lazy property usage resolves to the original property declaration")
    } finally {
        await dispose()
    }
})

it("tsserver definition resolves generated backing property usages to the source declaration", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const definitions = assertResponseBody<DefinitionInfo[]>(
            t,
            await request(sourceFile, "definition", backingUsageArgs(sourceFile))
        )

        t.true(definitions.some((definition) => {
            return definition.file === sourceFile &&
                sourceSlice(sourceText, definition) === "lazyProperty" &&
                definition.start.line === 5
        }), "Backing property usage resolves to the original property declaration")
    } finally {
        await dispose()
    }
})

it("tsserver quickinfo reports public and backing lazy property types", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const publicQuickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await request(sourceFile, "quickinfo", publicUsageArgs(sourceFile))
        )
        const backingQuickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await request(sourceFile, "quickinfo", backingUsageArgs(sourceFile))
        )

        t.true(
            publicQuickInfo.displayString?.includes("lazyProperty: Map<number, string>"),
            publicQuickInfo.displayString ?? "Missing public quickinfo"
        )
        t.true(
            backingQuickInfo.displayString?.includes("Map<number, string> | undefined"),
            backingQuickInfo.displayString ?? "Missing backing quickinfo"
        )
    } finally {
        await dispose()
    }
})

it("tsserver quickinfo and definition recover for backing property after a lazy type typo is fixed", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await runTypeScriptServerSession(sourceFile.slice(0, sourceFile.lastIndexOf("/")), async (session) => {
            await session.open({
                file            : sourceFile,
                fileContent     : sourceText,
                projectRootPath : sourceFile.slice(0, sourceFile.lastIndexOf("/"))
            })

            const insertionIndex = sourceText.indexOf("string>") + "string".length
            const insertionPoint = textRangeFromIndices(sourceText, insertionIndex, insertionIndex)

            await session.change({
                file         : sourceFile,
                insertString : "z",
                ...insertionPoint
            })

            const typoText     = `${sourceText.slice(0, insertionIndex)}z${sourceText.slice(insertionIndex)}`
            const deletionSpan = textRangeFromIndices(typoText, insertionIndex, insertionIndex + 1)

            await session.change({
                file         : sourceFile,
                insertString : "",
                ...deletionSpan
            })

            const fixedDiagnostics = await session.getDiagnostics([ sourceFile ])

            t.false(
                fixedDiagnostics.some((diagnostic) => diagnostic.code >= 2000),
                fixedDiagnostics.map((diagnostic) => `TS${diagnostic.code} ${diagnostic.text}`).join("\n")
            )

            const quickInfo = assertResponseBody<QuickInfoBody>(
                t,
                await session.request("quickinfo", backingUsageArgs(sourceFile))
            )
            const definitions = assertResponseBody<DefinitionInfo[]>(
                t,
                await session.request("definition", backingUsageArgs(sourceFile))
            )

            t.true(
                quickInfo.displayString?.includes("Map<number, string> | undefined"),
                quickInfo.displayString ?? "Missing backing quickinfo after type fix"
            )
            t.true(definitions.some((definition) => {
                return definition.file === sourceFile &&
                    sourceSlice(sourceText, definition) === "lazyProperty" &&
                    definition.start.line === 5
            }), "Backing property definition resolves to the original lazy property after type fix")
        })
    } finally {
        await dispose()
    }
})

it("tsserver references for lazyProperty exclude generated backing usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const body = assertResponseBody<ReferencesBody>(
            t,
            await request(sourceFile, "references", publicUsageArgs(sourceFile))
        )
        const referenceTexts = uniqueLocalSpanTexts(sourceFile, body.refs ?? [])

        t.expect(referenceTexts).toEqual([
            "lazyProperty"
        ])
        t.equal(countLocalSpans(sourceFile, body.refs ?? [], "lazyProperty"), 3, "References include declaration and public usages")
        t.equal(countLocalSpans(sourceFile, body.refs ?? [], "$lazyProperty"), 0, "References exclude backing usages")
    } finally {
        await dispose()
    }
})

it("tsserver document highlights for lazyProperty exclude generated backing usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const body = assertResponseBody<DocumentHighlightsBody>(
            t,
            await request(sourceFile, "documentHighlights", {
                ...publicUsageArgs(sourceFile),
                filesToSearch : [ sourceFile ]
            })
        )
        const spans = body.flatMap((item) => {
            return item.file === sourceFile ? item.highlightSpans : []
        })
        const highlightTexts = uniqueLocalSpanTexts(sourceFile, spans)

        t.expect(highlightTexts).toEqual([
            "lazyProperty"
        ])
        t.equal(countLocalSpans(sourceFile, spans, "lazyProperty"), 3, "Highlights include declaration and public usages")
        t.equal(countLocalSpans(sourceFile, spans, "$lazyProperty"), 0, "Highlights exclude backing usages")
    } finally {
        await dispose()
    }
})

async function createEditorFixture(): Promise<{
    dispose : () => Promise<void>,
    sourceFile : string
}> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : sourceText
            }
        ]
    })
    const sourceFile = fixture.sourceFiles.get("source.ts")

    if (sourceFile === undefined) {
        throw new Error("Missing fixture source file.")
    }

    return {
        dispose : fixture.dispose,
        sourceFile
    }
}

async function request(sourceFile: string, command: string, args: unknown): Promise<TsServerResponse> {
    return runTypeScriptServerRequest(
        sourceFile.slice(0, sourceFile.lastIndexOf("/")),
        sourceFile,
        sourceText,
        command,
        args
    )
}

function publicUsageArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, propertyAccessPosition("lazyProperty"))
    }
}

function backingUsageArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, propertyAccessPosition("$lazyProperty"))
    }
}

function assertResponseBody<Body>(t: Test, response: TsServerResponse): Body {
    t.true(response.success, response.message ?? `tsserver ${response.command ?? "request"} succeeds`)

    if (response.body === undefined) {
        throw new Error(`Missing tsserver response body: ${JSON.stringify(response)}`)
    }

    return response.body as Body
}

function uniqueLocalSpanTexts(sourceFile: string, spans: Array<TextSpan & { file?: string }>): string[] {
    return [ ...new Set(spans
        .filter((span) => span.file === undefined || span.file === sourceFile)
        .map((span) => sourceSlice(sourceText, span))
    ) ].sort()
}

function countLocalSpans(sourceFile: string, spans: Array<TextSpan & { file?: string }>, text: string): number {
    const keys = new Set(spans
        .filter((span) => span.file === undefined || span.file === sourceFile)
        .filter((span) => sourceSlice(sourceText, span) === text)
        .map((span) => `${span.start.line}:${span.start.offset}:${span.end.line}:${span.end.offset}`)
    )

    return keys.size
}

function sourceSlice(source: string, span: TextSpan): string {
    return source.slice(positionToIndex(source, span.start), positionToIndex(source, span.end))
}

function positionToIndex(source: string, position: TextPosition): number {
    const lines = source.split("\n")
    const beforeLine = lines
        .slice(0, position.line - 1)
        .reduce((sum, line) => sum + line.length + 1, 0)

    return beforeLine + position.offset - 1
}

function propertyAccessPosition(propertyName: string): number {
    const accessText = `instance.${propertyName}`

    return sourceText.indexOf(accessText) + "instance.".length + 1
}

function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
