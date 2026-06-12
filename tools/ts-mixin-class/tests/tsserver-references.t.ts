import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertResponseBody } from "./tsserver-util.js"
import {
    consumerSuperMixinMethodArgs,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    selfMixinPropertyArgs,
    sourceSlice,
    sourceText,
    superMixinMethodArgs,
    superMixinPropertyArgs,
    usageArgs
} from "./tsserver-editor-util.js"
import type { TextSpan } from "./tsserver-editor-util.js"

type ReferencesBody = {
    refs? : Array<TextSpan & {
        file : string,
        isDefinition? : boolean
    }>
}

it("tsserver references resolve mixin properties from self, external and super usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinPropertyArgs(sourceFile), description : "self mixin property usage" },
            { args : usageArgs(sourceFile, "mixinProperty"), description : "external mixin property usage" },
            { args : superMixinPropertyArgs(sourceFile), description : "mixin super property usage" },
            { args : consumerSuperMixinPropertyArgs(sourceFile), description : "consumer super property usage" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ "mixinProperty" ])
            t.equal(countLocalSpans(sourceFile, refs, "mixinProperty"), 5, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver references resolve mixin methods from self, external and super usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinMethodArgs(sourceFile), description : "self mixin method call" },
            { args : usageArgs(sourceFile, "mixinMethod"), description : "external mixin method call" },
            { args : superMixinMethodArgs(sourceFile), description : "mixin super method call" },
            { args : consumerSuperMixinMethodArgs(sourceFile), description : "consumer super method call" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ "mixinMethod" ])
            t.equal(countLocalSpans(sourceFile, refs, "mixinMethod"), 5, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

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
