import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, trimIndent } from "./util.js"
import { positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
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

const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceMixin {
        mixinProperty: string = "mixin"

        mixinMethod(): string {
            return this.mixinProperty
        }
    }

    class PlainBase {
        baseProperty: number = 42

        baseMethod(): number {
            return this.baseProperty
        }
    }

    class PlainConsumer extends PlainBase {
    }

    class MixinConsumer implements SourceMixin {
    }

    const plain = new PlainConsumer()
    const mixed = new MixinConsumer()

    plain.baseProperty
    plain.baseMethod()
    mixed.mixinProperty
    mixed.mixinMethod()
`)

it("tsserver definition resolves plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertDefinition(t, sourceFile, "baseProperty", "baseProperty: number", "Plain base property")
        await assertDefinition(t, sourceFile, "baseMethod", "baseMethod(): number", "Plain base method")
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin property")
        await assertDefinition(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Mixin method")
        await assertDefinition(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Mixin self property",
            selfMixinPropertyArgs(sourceFile)
        )
    } finally {
        await dispose()
    }
})

it("tsserver quickinfo reports plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertQuickInfo(t, sourceFile, "baseProperty", [ "baseProperty: number", "PlainBase.baseProperty" ])
        await assertQuickInfo(t, sourceFile, "baseMethod", [ "baseMethod(): number", "PlainBase.baseMethod" ])
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ])
        await assertQuickInfo(t, sourceFile, "mixinMethod", [ "(method)", "mixinMethod(): string" ])
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinProperty",
            [ "(property)", "mixinProperty: string" ],
            selfMixinPropertyArgs(sourceFile)
        )
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

async function assertDefinition(
    t: Test,
    sourceFile: string,
    memberName: string,
    declarationText: string,
    description: string,
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await request(sourceFile, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === sourceFile &&
            sourceSlice(sourceText, definition) === memberName &&
            sourceText.slice(positionToIndex(sourceText, definition.start)).startsWith(declarationText)
    }), `${description} usage resolves to its source declaration`)
}

async function assertQuickInfo(
    t: Test,
    sourceFile: string,
    memberName: string,
    expectedParts: string[],
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await request(sourceFile, "quickinfo", args)
    )

    t.true(
        expectedParts.every((expectedPart) => {
            return quickInfo.displayString?.includes(expectedPart) === true
        }),
        quickInfo.displayString ?? `Missing quickinfo for ${memberName}`
    )
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

function usageArgs(sourceFile: string, memberName: string): { file: string, line: number, offset: number } {
    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, memberUsagePosition(memberName))
    }
}

function selfMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    const accessText = "this.mixinProperty"
    const position   = sourceText.indexOf(accessText)

    if (position < 0) {
        throw new Error("Cannot find mixin self property usage.")
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, position + "this.".length + 1)
    }
}

function memberUsagePosition(memberName: string): number {
    const receivers = [ "plain", "mixed" ]

    for (const receiver of receivers) {
        const accessText = `${receiver}.${memberName}`
        const position   = sourceText.indexOf(accessText)

        if (position >= 0) {
            return position + receiver.length + 1 + 1
        }
    }

    throw new Error(`Cannot find member usage: ${memberName}`)
}

function assertResponseBody<Body>(t: Test, response: TsServerResponse): Body {
    t.true(response.success, response.message ?? `tsserver ${response.command ?? "request"} succeeds`)

    if (response.body === undefined) {
        throw new Error(`Missing tsserver response body: ${JSON.stringify(response)}`)
    }

    return response.body as Body
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
