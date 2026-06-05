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
    locs? : RenameFileLocation[]
}

type RenameFileLocation = {
    file : string,
    locs : RenameLocation[]
}

type RenameLocation = {
    start : TextPosition,
    end : TextPosition
}

type TextPosition = {
    line : number,
    offset : number
}

const sourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: Map<number, string> = new Map()
        regularProperty: string = "ok"
    }

    const instance = new SourceClass()

    console.log(instance.lazyProperty)
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

        const renamedText = assertRenameAllowed(t, response, sourceFile, sourceText, "regularProperty", "renamedRegularProperty")

        t.true(renamedText.includes('renamedRegularProperty: string = "ok"'), "Renames regular property declaration")
        t.true(renamedText.includes("instance.renamedRegularProperty"), "Renames regular property usage")
        t.false(renamedText.includes('regularProperty: string = "ok"'), "Removes old regular property declaration")
        t.false(renamedText.includes("instance.regularProperty"), "Removes old regular property usage")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver can rename a regular property usage", async (t: Test) => {
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
                ...positionToLineOffset(sourceText, propertyAccessPosition(sourceText, "regularProperty"))
            }
        )

        const renamedText = assertRenameAllowed(t, response, sourceFile, sourceText, "regularProperty", "renamedRegularProperty")

        t.true(renamedText.includes('renamedRegularProperty: string = "ok"'), "Renames regular property declaration")
        t.true(renamedText.includes("instance.renamedRegularProperty"), "Renames regular property usage")
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

it("tsserver can rename a lazy property declaration", async (t: Test) => {
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

        const renamedText = assertRenameAllowed(t, response, sourceFile, sourceText, "lazyProperty", "renamedLazyProperty")

        t.true(renamedText.includes("renamedLazyProperty: Map<number, string> = new Map()"), "Renames lazy property declaration")
        t.true(renamedText.includes("instance.renamedLazyProperty"), "Renames lazy property usage")
        t.false(renamedText.includes("lazyProperty: Map<number, string> = new Map()"), "Removes old lazy property declaration")
        t.false(renamedText.includes("instance.lazyProperty"), "Removes old lazy property usage")
        t.true(renamedText.includes("instance.$lazyProperty"), "Leaves backing property usage unchanged")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver can rename a lazy property usage", async (t: Test) => {
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
                ...positionToLineOffset(sourceText, propertyAccessPosition(sourceText, "lazyProperty"))
            }
        )

        const renamedText = assertRenameAllowed(t, response, sourceFile, sourceText, "lazyProperty", "renamedLazyProperty")

        t.true(renamedText.includes("renamedLazyProperty: Map<number, string> = new Map()"), "Renames lazy property declaration")
        t.true(renamedText.includes("instance.renamedLazyProperty"), "Renames lazy property usage")
        t.true(renamedText.includes("instance.$lazyProperty"), "Leaves backing property usage unchanged")
    } finally {
        await fixture.dispose()
    }
})

function assertRenameAllowed(
    t: Test,
    response: TsServerResponse,
    sourceFile: string,
    source: string,
    displayName: string,
    nextName: string
): string {
    const body = response.body as RenameResponseBody | undefined

    t.true(response.success, response.message ?? "tsserver handles rename request")
    t.equal(response.command, "rename", "Response belongs to the rename command")
    t.true(body?.info?.canRename, JSON.stringify(response.body))
    t.equal(body?.info?.displayName, displayName, "Rename info points at the source property")
    t.true(Array.isArray(body?.locs) && body.locs.length > 0, "Rename response contains rename locations")

    return applyRenameLocations(source, sourceFile, body?.locs ?? [], nextName)
}

function applyRenameLocations(
    source: string,
    sourceFile: string,
    fileLocations: RenameFileLocation[],
    nextName: string
): string {
    const edits = fileLocations
        .filter((fileLocation) => fileLocation.file === sourceFile)
        .flatMap((fileLocation) => fileLocation.locs)
        .map((location) => {
            return {
                start : positionToIndex(source, location.start),
                end   : positionToIndex(source, location.end)
            }
        })
        .sort((left, right) => right.start - left.start)

    let nextSource = source

    for (const edit of edits) {
        nextSource = `${nextSource.slice(0, edit.start)}${nextName}${nextSource.slice(edit.end)}`
    }

    return nextSource
}

function positionToIndex(source: string, position: TextPosition): number {
    const lines = source.split("\n")
    const beforeLine = lines
        .slice(0, position.line - 1)
        .reduce((sum, line) => sum + line.length + 1, 0)

    return beforeLine + position.offset - 1
}

function propertyAccessPosition(source: string, propertyName: string): number {
    const accessText = `instance.${propertyName}`

    return source.indexOf(accessText) + "instance.".length + 1
}

function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
