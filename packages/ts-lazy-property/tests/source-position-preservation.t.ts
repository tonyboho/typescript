import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import { trimIndent } from "./util.js"

type SourceSpan = {
    pos    : number,
    end    : number,
    start  : number,
    finish : number,
    text   : string
}

type StableSignatureCollection = {
    counts                          : Map<string, number>,
    syntheticOutsideGeneratedRanges : string[],
    total                           : number
}

const sourceCases = [
    {
        fileName : "basic.ts",
        text     : `
            import { lazy } from "ts-lazy-property"

            class SourceClass {
                @lazy()
                lazyProperty: Map<number, string> = new Map()
                regularProperty: string = "ok"
            }

            const instance = new SourceClass()

            instance.lazyProperty.set(2, "ok")
            console.log(instance.$lazyProperty)
            console.log(instance.regularProperty)
        `
    },
    {
        fileName : "imports.ts",
        text     : `
            import * as LazyProperty from "ts-lazy-property"
            import { lazy as delayed } from "ts-lazy-property"

            function lazy(..._args: unknown[]): void {
            }

            class SourceClass {
                @delayed()
                lazyProperty1: Map<number, string> = new Map()

                @LazyProperty.lazy()
                lazyProperty2: Set<string> = new Set()

                @lazy
                regularProperty: string = "ok"
            }

            const instance = new SourceClass()

            console.log(instance.$lazyProperty1)
            console.log(instance.$lazyProperty2)
            console.log(instance.regularProperty)
        `
    }
]

it("preserves source positions outside generated lazy members", async (t: Test) => {
    for (const sourceCase of sourceCases) {
        await t.subTest(sourceCase.fileName, async (t: Test) => {
            const originalSourceFile    = createSourceFile(sourceCase.fileName, trimIndent(sourceCase.text))
            const transformedSourceFile = transformSourceFile(ts, originalSourceFile, {
                preserveLazyDecorator : true
            })
            const generatedRanges       = collectGeneratedLazyMemberRanges(transformedSourceFile)
            const originalStable        = collectStableSignatures(originalSourceFile, originalSourceFile, generatedRanges)
            const transformedStable     = collectStableSignatures(transformedSourceFile, transformedSourceFile, generatedRanges)
            const missingOriginal       = subtractSignatureCounts(originalStable.counts, transformedStable.counts)
            const unexpectedTransformed = subtractSignatureCounts(transformedStable.counts, originalStable.counts)

            t.true(generatedRanges.length > 0, "Fixture has generated lazy member ranges")
            t.expect(formatRanges(originalSourceFile, generatedRanges)).toEqual(formatRanges(transformedSourceFile, generatedRanges))
            t.equal(transformedSourceFile.text, originalSourceFile.text, "Transformed SourceFile keeps the original source text")
            t.equal(originalStable.total, transformedStable.total, "Stable node count matches")
            t.expect(missingOriginal).toEqual([])
            t.expect(unexpectedTransformed).toEqual([])
            t.expect(transformedStable.syntheticOutsideGeneratedRanges).toEqual([])
        })
    }
})

function createSourceFile(fileName: string, text: string): ts.SourceFile {
    return ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
    )
}

function collectGeneratedLazyMemberRanges(sourceFile: ts.SourceFile): SourceSpan[] {
    const ranges: SourceSpan[] = []

    const visit = (node: ts.Node): void => {
        if (isGeneratedLazyClassMember(node)) {
            ranges.push(expandRangeToLeadingDecorators(sourceFile, nodeSpan(node, sourceFile)))
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    return mergeRanges(sourceFile, deduplicateRanges(ranges))
}

function isGeneratedLazyClassMember(node: ts.Node): node is ts.ClassElement {
    if (!ts.isPropertyDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) {
        return false
    }

    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        return true
    }

    return ts.isIdentifier(node.name) && node.name.text.startsWith("$")
}

function collectStableSignatures(
    root: ts.Node,
    sourceFile: ts.SourceFile,
    generatedRanges: SourceSpan[]
): StableSignatureCollection {
    const counts                                     = new Map<string, number>()
    const syntheticOutsideGeneratedRanges : string[] = []
    let total                                        = 0

    const visit = (node: ts.Node): void => {
        const span = sourceSpan(node, sourceFile)

        if (span === undefined) {
            if (!hasAncestorInsideRange(node, sourceFile, generatedRanges)) {
                syntheticOutsideGeneratedRanges.push(formatNodeLine(node, sourceFile))
            }

            ts.forEachChild(node, visit)
            return
        }

        if (node.kind !== ts.SyntaxKind.SourceFile && isInsideAnyRange(span, generatedRanges)) {
            return
        }

        const signature = nodeSignature(node, sourceFile)

        counts.set(signature, (counts.get(signature) ?? 0) + 1)
        total += 1

        ts.forEachChild(node, visit)
    }

    visit(root)

    return {
        counts,
        syntheticOutsideGeneratedRanges,
        total
    }
}

function subtractSignatureCounts(left: Map<string, number>, right: Map<string, number>): string[] {
    const result: string[] = []

    for (const [ signature, count ] of left) {
        const missingCount = count - (right.get(signature) ?? 0)

        for (let index = 0; index < missingCount; index += 1) {
            result.push(signature)
        }
    }

    return result
}

function hasAncestorInsideRange(node: ts.Node, sourceFile: ts.SourceFile, ranges: SourceSpan[]): boolean {
    let current = node.parent

    while (current !== undefined) {
        const span = sourceSpan(current, sourceFile)

        if (span !== undefined && isInsideAnyRange(span, ranges)) {
            return true
        }

        current = current.parent
    }

    return false
}

function deduplicateRanges(ranges: SourceSpan[]): SourceSpan[] {
    const seen = new Set<string>()

    return ranges.filter((range) => {
        const key = `${range.pos}:${range.end}:${range.start}:${range.finish}`

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

function mergeRanges(sourceFile: ts.SourceFile, ranges: SourceSpan[]): SourceSpan[] {
    const sorted               = [ ...ranges ].sort((left, right) => {
        return left.pos - right.pos || left.end - right.end
    })
    const result: SourceSpan[] = []

    for (const range of sorted) {
        const previous = result.at(-1)

        if (previous === undefined || range.pos > previous.end) {
            result.push({ ...range })
            continue
        }

        previous.pos    = Math.min(previous.pos, range.pos)
        previous.end    = Math.max(previous.end, range.end)
        previous.start  = Math.min(previous.start, range.start)
        previous.finish = Math.max(previous.finish, range.finish)
        previous.text   = sourceFile.text.slice(previous.start, previous.finish).replaceAll("\n", "\\n")
    }

    return result
}

function expandRangeToLeadingDecorators(sourceFile: ts.SourceFile, range: SourceSpan): SourceSpan {
    const decoratorStart = findLeadingDecoratorStart(sourceFile.text, range.start)

    if (decoratorStart === undefined) {
        return range
    }

    const pos = findTriviaStartBefore(sourceFile.text, decoratorStart)

    return {
        ...range,
        pos,
        start : decoratorStart,
        text  : sourceFile.text.slice(decoratorStart, range.finish).replaceAll("\n", "\\n")
    }
}

function findLeadingDecoratorStart(text: string, position: number): number | undefined {
    let lineStart                           = text.lastIndexOf("\n", position - 1) + 1
    let decoratorStart : number | undefined = undefined

    while (lineStart > 0) {
        const previousLineEnd   = lineStart - 1
        const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1
        const previousLine      = text.slice(previousLineStart, previousLineEnd)
        const indentLength      = previousLine.match(/^\s*/)?.[0].length ?? 0
        const firstToken        = previousLineStart + indentLength

        if (previousLine.trim() === "" || text[firstToken] !== "@") {
            break
        }

        decoratorStart = firstToken
        lineStart      = previousLineStart
    }

    return decoratorStart
}

function findTriviaStartBefore(text: string, position: number): number {
    let triviaStart = position

    while (triviaStart > 0 && /\s/.test(text[triviaStart - 1])) {
        triviaStart -= 1
    }

    return triviaStart
}

function nodeSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
    const span = nodeSpan(node, sourceFile)

    return [
        ts.SyntaxKind[node.kind],
        nodeLabel(node),
        span.pos,
        span.end,
        span.start,
        span.finish,
        JSON.stringify(span.text)
    ].join(" | ")
}

function sourceSpan(node: ts.Node, sourceFile: ts.SourceFile): SourceSpan | undefined {
    if (node.pos < 0 || node.end < 0) {
        return undefined
    }

    return nodeSpan(node, sourceFile)
}

function nodeSpan(node: ts.Node, sourceFile: ts.SourceFile): SourceSpan {
    const start  = node.getStart(sourceFile)
    const finish = node.getEnd()

    return {
        pos  : node.pos,
        end  : node.end,
        start,
        finish,
        text : sourceFile.text.slice(start, finish).replaceAll("\n", "\\n")
    }
}

function isInsideAnyRange(span: SourceSpan, ranges: SourceSpan[]): boolean {
    return ranges.some((range) => {
        return span.pos >= range.pos && span.end <= range.end
    })
}

function formatRanges(sourceFile: ts.SourceFile, ranges: SourceSpan[]): string[] {
    return ranges.map((range) => {
        return formatRange(sourceFile, range)
    })
}

function formatRange(sourceFile: ts.SourceFile, span: SourceSpan): string {
    const start  = sourceFile.getLineAndCharacterOfPosition(span.start)
    const finish = sourceFile.getLineAndCharacterOfPosition(span.finish)

    return [
        `pos/end ${span.pos}/${span.end}`,
        `start ${span.start} (${start.line + 1}:${start.character + 1})`,
        `end ${span.finish} (${finish.line + 1}:${finish.character + 1})`,
        JSON.stringify(span.text)
    ].join(" ")
}

function formatNodeLine(node: ts.Node, sourceFile: ts.SourceFile): string {
    const span = sourceSpan(node, sourceFile)

    if (span === undefined) {
        return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} synthetic`
    }

    return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} ${formatRange(sourceFile, span)}`
}

function nodeLabel(node: ts.Node): string {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        return node.text
    }

    const name = "name" in node ? node.name : undefined

    if (isNode(name) && ts.isIdentifier(name)) {
        return name.text
    }

    if ("text" in node && typeof node.text === "string") {
        return node.text
    }

    return "<none>"
}

function isNode(value: unknown): value is ts.Node {
    return typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "number"
}
