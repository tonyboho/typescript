import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import { createTypeScriptFixture, trimIndent } from "./util.js"

type ProbeSnapshot = {
    classMembers : ProbeNode[],
    fileName     : string,
    firstBacking : ProbeNode | undefined,
    text         : string,
    textLength   : number
}

type ProbeNode = {
    end    : number,
    finish : number,
    kind   : string,
    name   : string,
    pos    : number,
    start  : number,
    text   : string
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

const probePluginName = "ts-lazy-property-tsserver-test-probe"

it("tsserver sees the original source text while using the transformed AST", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        compilerPlugins : [
            {
                name : probePluginName
            }
        ],
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

        const snapshot      = await runTypeScriptServerSnapshot(
            fixture.directory,
            sourceFile,
            sourceText
        )
        const backingMember = snapshot.classMembers.find((member) => member.name === "$lazyProperty")
        const getterMember  = snapshot.classMembers.find((member) => member.kind === "GetAccessor")
        const setterMember  = snapshot.classMembers.find((member) => member.kind === "SetAccessor")
        const regularMember = snapshot.classMembers.find((member) => member.name === "regularProperty")

        t.equal(snapshot.fileName, sourceFile, "Probe inspected the opened fixture source")
        t.equal(snapshot.text, sourceText, "tsserver SourceFile text remains the original source")
        t.equal(snapshot.textLength, sourceText.length, "tsserver SourceFile text length remains unchanged")

        t.ok(backingMember, "tsserver sees generated backing property in the AST")
        t.ok(getterMember, "tsserver sees generated getter in the AST")
        t.ok(setterMember, "tsserver sees generated setter in the AST")
        t.ok(regularMember, "tsserver keeps the regular source property")

        t.equal(snapshot.firstBacking?.name, "$lazyProperty", "Generated backing identifier exists")
        t.equal(snapshot.firstBacking?.text, "lazyProperty", "Generated backing identifier maps to the original lazy property name")
        t.true(backingMember?.text.includes("@lazy()"), "Generated backing property carries the original decorator range")
        t.true(getterMember?.text.startsWith("lazyProperty"), "Generated getter starts at the original property declaration")
        t.equal(setterMember?.text, "", "Generated setter does not compete for source rename range")
        t.equal(regularMember?.text, 'regularProperty: string = "ok"', "Regular property keeps its own source range")
    } finally {
        await fixture.dispose()
    }
})

async function runTypeScriptServerSnapshot(
    fixtureDirectory: string,
    sourceFile: string,
    text: string
): Promise<ProbeSnapshot> {
    const pluginDirectory = path.join(fixtureDirectory, "node_modules", probePluginName)
    const logFile         = path.join(fixtureDirectory, "tsserver.log")

    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({
        main : "index.cjs",
        name : probePluginName,
        type : "commonjs"
    }, null, 4))
    await writeFile(path.join(pluginDirectory, "index.cjs"), createProbePluginSource())

    await runTypeScriptServerRequest(
        fixtureDirectory,
        sourceFile,
        text,
        "quickinfo",
        {
            file : sourceFile,
            ...positionToLineOffset(text, text.indexOf("$lazyProperty"))
        },
        logFile
    )

    return readProbeSnapshot(logFile)
}

async function readProbeSnapshot(logFile: string): Promise<ProbeSnapshot> {
    const logText = await readFile(logFile, "utf8")
    const marker  = "[ts-lazy-property-test-probe] "
    const line    = logText.split("\n").find((line) => line.includes(marker))

    if (line === undefined) {
        throw new Error(`Cannot find tsserver probe snapshot in ${logFile}.\n${tail(logText, 80)}`)
    }

    return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as ProbeSnapshot
}

function createProbePluginSource(): string {
    return `
        "use strict"

        module.exports = function init(modules) {
            const ts = modules.typescript

            return {
                create(info) {
                    const proxy = Object.create(null)

                    for (const key of Object.keys(info.languageService)) {
                        const value = info.languageService[key]
                        proxy[key] = typeof value === "function" ? value.bind(info.languageService) : value
                    }

                    proxy.getQuickInfoAtPosition = (fileName, position) => {
                        const program    = info.languageService.getProgram()
                        const sourceFile = program && program.getSourceFile(fileName)

                        if (sourceFile) {
                            info.project.projectService.logger.info("[ts-lazy-property-test-probe] " + JSON.stringify(snapshot(ts, sourceFile)))
                        }

                        return info.languageService.getQuickInfoAtPosition(fileName, position)
                    }

                    return proxy
                }
            }
        }

        function snapshot(ts, sourceFile) {
            return {
                classMembers : classMembers(ts, sourceFile),
                fileName     : sourceFile.fileName,
                firstBacking : formatOptionalNode(ts, sourceFile, findBackingDeclarationName(ts, sourceFile)),
                text         : sourceFile.text,
                textLength   : sourceFile.text.length
            }
        }

        function classMembers(ts, sourceFile) {
            const sourceClass = findFirst(ts, sourceFile, node => ts.isClassDeclaration(node) && node.name && node.name.text === "SourceClass")

            return sourceClass ? sourceClass.members.map(member => formatNode(ts, sourceFile, member)) : []
        }

        function findBackingDeclarationName(ts, sourceFile) {
            const sourceClass = findFirst(ts, sourceFile, node => ts.isClassDeclaration(node) && node.name && node.name.text === "SourceClass")

            if (!sourceClass) return undefined

            const backingMember = sourceClass.members.find(member => {
                return ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.name.text === "$lazyProperty"
            })

            return backingMember && backingMember.name
        }

        function findFirst(ts, root, predicate) {
            let found

            const visit = node => {
                if (found !== undefined) return
                if (predicate(node)) {
                    found = node
                    return
                }
                ts.forEachChild(node, visit)
            }

            visit(root)

            return found
        }

        function formatOptionalNode(ts, sourceFile, node) {
            return node === undefined ? undefined : formatNode(ts, sourceFile, node)
        }

        function formatNode(ts, sourceFile, node) {
            if (node.pos < 0 || node.end < 0) {
                return {
                    end    : node.end,
                    finish : node.end,
                    kind   : ts.SyntaxKind[node.kind],
                    name   : nodeName(ts, node),
                    pos    : node.pos,
                    start  : node.pos,
                    text   : ""
                }
            }

            const start  = node.getStart(sourceFile)
            const finish = node.getEnd()

            return {
                end    : node.end,
                finish,
                kind   : ts.SyntaxKind[node.kind],
                name   : nodeName(ts, node),
                pos    : node.pos,
                start,
                text   : sourceFile.text.slice(start, finish)
            }
        }

        function nodeName(ts, node) {
            if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
            if (node.name && ts.isIdentifier(node.name)) return node.name.text
            if (typeof node.text === "string") return node.text
            return "<none>"
        }
    `
}


function tail(text: string, lineCount: number): string {
    return text.split("\n").slice(-lineCount).join("\n")
}
