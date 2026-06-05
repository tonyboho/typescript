import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import { positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import type { TsServerResponse } from "./tsserver-util.js"

type RenameResponseBody = {
    info? : {
        canRename? : boolean,
        displayName? : string
    },
    locs? : unknown[]
}

const sourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()
        regularProperty: string = "ok"
    }

    const instance = new SourceClass()

    console.log(instance.$lazyProperty)
    console.log(instance.regularProperty)
`)

it("tsserver can rename a regular property declaration", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : sourceText
            }
        ]
    })

    try {
        const sourceFile = fixture.sourceFiles.get("source.ts")

        if (sourceFile === undefined) {
            throw new Error("Missing fixture source file.")
        }

        const response = await runTypeScriptServerRequest(
            fixture.directory,
            sourceFile,
            sourceText,
            "rename",
            {
                file : sourceFile,
                ...positionToLineOffset(sourceText, sourceText.indexOf("regularProperty") + 1)
            }
        )

        assertRenameAllowed(t, response, "regularProperty")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver rename request does not crash on a lazy property declaration", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : sourceText
            }
        ]
    })

    try {
        const sourceFile = fixture.sourceFiles.get("source.ts")

        if (sourceFile === undefined) {
            throw new Error("Missing fixture source file.")
        }

        const response = await runTypeScriptServerRequest(
            fixture.directory,
            sourceFile,
            sourceText,
            "rename",
            {
                file : sourceFile,
                ...positionToLineOffset(sourceText, sourceText.indexOf("lazyProperty") + 1)
            }
        )

        t.true(response.success, response.message ?? "tsserver handles rename request without a debug failure")
        t.equal(response.command, "rename", "Response belongs to the rename command")
    } finally {
        await fixture.dispose()
    }
})

function assertRenameAllowed(t: Test, response: TsServerResponse, displayName: string): void {
    const body = response.body as RenameResponseBody | undefined

    t.true(response.success, response.message ?? "tsserver handles rename request")
    t.equal(response.command, "rename", "Response belongs to the rename command")
    t.true(body?.info?.canRename, JSON.stringify(response.body))
    t.equal(body?.info?.displayName, displayName, "Rename info points at the source property")
    t.true(Array.isArray(body?.locs) && body.locs.length > 0, "Rename response contains rename locations")
}

function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
