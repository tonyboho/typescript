import path from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { transformSourceFile } from "../dist/src/index.js"

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtureFile      = path.join(packageDirectory, "fixtures/basic-project/src/basic.ts")

const compilerOptions = {
    module                 : ts.ModuleKind.NodeNext,
    moduleResolution       : ts.ModuleResolutionKind.NodeNext,
    target                 : ts.ScriptTarget.ES2022,
    strict                 : true,
    noEmit                 : true,
    experimentalDecorators : true,
    skipLibCheck           : true,
    lib                    : [ "lib.es2022.d.ts", "lib.dom.d.ts" ]
}

const host       = ts.createCompilerHost(compilerOptions, true)
const sourceFile = host.getSourceFile(fixtureFile, compilerOptions.target)

if (sourceFile === undefined) {
    throw new Error(`Cannot read fixture: ${fixtureFile}`)
}

const transformedSourceFile = transformSourceFile(ts, sourceFile)
const lazyRanges            = collectLazyPropertyRanges(sourceFile)
const nextHost              = {
    ...host,

    getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
        if (path.resolve(fileName) === fixtureFile) {
            return transformedSourceFile
        }

        return host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }
}

const program = ts.createProgram([ fixtureFile ], compilerOptions, nextHost)
const checker = program.getTypeChecker()
const checked = program.getSourceFile(fixtureFile)

if (checked === undefined) {
    throw new Error(`Cannot read checked source: ${fixtureFile}`)
}

console.log(`fixture: ${path.relative(packageDirectory, fixtureFile)}`)
console.log("")

printLazyRanges(sourceFile, lazyRanges)
printTree("Original AST", sourceFile, sourceFile, lazyRanges)
printTree("Transformed AST", checked, checked, lazyRanges)
printInvariantReport(sourceFile, checked, lazyRanges)
printFocusedReport(checked, checker)

function collectLazyPropertyRanges(root) {
    const ranges = []

    const visit = (node) => {
        if (ts.isPropertyDeclaration(node) &&
            node.modifiers?.some((modifier) => {
                return ts.isDecorator(modifier) &&
                    modifier.getText(root).startsWith("@lazy")
            })
        ) {
            ranges.push(nodeSpan(node, root))
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(root)

    return ranges
}

function printLazyRanges(source, ranges) {
    console.log("Lazy source ranges:")

    for (const range of ranges) {
        console.log(`- ${formatRange(source, range)} ${JSON.stringify(range.text)}`)
    }

    console.log("")
}

function printTree(title, root, source, ranges) {
    console.log(`${title}:`)

    const visit = (node, depth) => {
        console.log(`${"  ".repeat(depth)}${formatNodeLine(node, source, ranges)}`)
        ts.forEachChild(node, (child) => visit(child, depth + 1))
    }

    visit(root, 0)
    console.log("")
}

function printInvariantReport(original, transformed, ranges) {
    const originalStable    = collectStableSignatures(original, original, ranges)
    const transformedStable = collectStableSignatures(transformed, transformed, ranges)
    const missing           = subtractSignatureCounts(originalStable.counts, transformedStable.counts)
    const unexpected        = subtractSignatureCounts(transformedStable.counts, originalStable.counts)
    const syntheticOutside  = transformedStable.syntheticOutside

    console.log("Invariant check:")
    console.log(`- original stable nodes: ${originalStable.total}`)
    console.log(`- transformed stable nodes: ${transformedStable.total}`)
    console.log(`- missing original stable nodes: ${missing.length}`)
    console.log(`- unexpected transformed nodes outside lazy ranges: ${unexpected.length}`)
    console.log(`- synthetic transformed nodes outside lazy ranges: ${syntheticOutside.length}`)

    printProblemList("Missing original stable nodes", missing)
    printProblemList("Unexpected transformed nodes outside lazy ranges", unexpected)
    printProblemList("Synthetic transformed nodes outside lazy ranges", syntheticOutside)

    console.log("")
}

function printFocusedReport(source, typeChecker) {
    const sourceClass = findFirst(source, (node) => {
        return ts.isClassDeclaration(node) && node.name?.text === "SourceClass"
    })

    const backingMember = sourceClass?.members.find((member) => {
        return ts.isPropertyDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === "$lazyProperty"
    })

    const getterMember = sourceClass?.members.find((member) => {
        return ts.isGetAccessorDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === "lazyProperty"
    })

    const regularMember = sourceClass?.members.find((member) => {
        return ts.isPropertyDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.name.text === "regularProperty"
    })

    const usageName = findFirst(source, (node) => {
        return ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "instance" &&
            node.name.text === "$lazyProperty"
    })?.name

    console.log("Focused nodes:")
    printNode(backingMember, source, "backing member")
    printNode(backingMember?.name, source, "backing member name")
    printNode(getterMember, source, "getter member")
    printNode(getterMember?.name, source, "getter member name")
    printNode(regularMember, source, "regular member")
    printNode(regularMember?.name, source, "regular member name")
    printNode(usageName, source, "usage name")

    console.log("")
    console.log("Checker symbol for usage:")

    if (usageName === undefined) {
        console.log("usage name: <missing>")
        return
    }

    const symbol = typeChecker.getSymbolAtLocation(usageName)

    console.log(`symbol: ${symbol?.getName() ?? "<missing>"}`)

    for (const declaration of symbol?.declarations ?? []) {
        printNode(declaration, source, "symbol declaration")
        printNode(memberName(declaration), source, "symbol declaration name")
    }
}

function collectStableSignatures(root, source, ranges) {
    const counts           = new Map()
    const syntheticOutside = []
    let total              = 0

    const visit = (node) => {
        const span = sourceSpan(node, source)

        if (span === undefined) {
            if (!hasSyntheticAncestorInsideLazyRange(node, source, ranges)) {
                syntheticOutside.push(formatNodeLine(node, source, ranges))
            }

            ts.forEachChild(node, visit)
            return
        }

        if (isInsideAnyRange(span, ranges) && node.kind !== ts.SyntaxKind.SourceFile) {
            return
        }

        const signature = nodeSignature(node, source)

        counts.set(signature, (counts.get(signature) ?? 0) + 1)
        total += 1

        ts.forEachChild(node, visit)
    }

    visit(root)

    return {
        counts,
        syntheticOutside,
        total
    }
}

function subtractSignatureCounts(left, right) {
    const result = []

    for (const [ signature, count ] of left) {
        const missingCount = count - (right.get(signature) ?? 0)

        for (let index = 0; index < missingCount; index += 1) {
            result.push(signature)
        }
    }

    return result
}

function printProblemList(title, items) {
    if (items.length === 0) {
        return
    }

    console.log(`${title}:`)

    for (const item of items) {
        console.log(`  ${item}`)
    }
}

function hasSyntheticAncestorInsideLazyRange(node, source, ranges) {
    let current = node.parent

    while (current !== undefined) {
        const span = sourceSpan(current, source)

        if (span !== undefined && isInsideAnyRange(span, ranges)) {
            return true
        }

        current = current.parent
    }

    return false
}

function isInsideAnyRange(span, ranges) {
    return ranges.some((range) => {
        return span.pos >= range.pos && span.end <= range.end
    })
}

function findFirst(root, predicate) {
    let found

    const visit = (node) => {
        if (found !== undefined) {
            return
        }

        if (predicate(node)) {
            found = node
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(root)

    return found
}

function memberName(node) {
    if (node !== undefined &&
        "name" in node &&
        node.name !== undefined &&
        typeof node.name.kind === "number"
    ) {
        return node.name
    }

    return undefined
}

function nodeSignature(node, source) {
    const span = nodeSpan(node, source)

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

function formatNodeLine(node, source, ranges) {
    const span       = sourceSpan(node, source)
    const annotation = span !== undefined && isInsideAnyRange(span, ranges)
        ? " lazy-range"
        : ""

    if (span === undefined) {
        return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} synthetic`
    }

    return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} ${formatRange(source, span)}${annotation} ${JSON.stringify(span.text)}`
}

function printNode(node, source, label) {
    if (node === undefined) {
        console.log(`${label}: <missing>`)
        return
    }

    console.log(`${label}: ${formatNodeLine(node, source, [])}`)
}

function nodeLabel(node) {
    return node.text ?? node.name?.text ?? "<none>"
}

function sourceSpan(node, source) {
    if (node.pos < 0 || node.end < 0) {
        return undefined
    }

    return nodeSpan(node, source)
}

function nodeSpan(node, source) {
    const start  = node.getStart(source)
    const finish = node.getEnd()

    return {
        pos  : node.pos,
        end  : node.end,
        start,
        finish,
        text : source.text.slice(start, finish).replaceAll("\n", "\\n")
    }
}

function formatRange(source, span) {
    const pos    = source.getLineAndCharacterOfPosition(span.pos)
    const start  = source.getLineAndCharacterOfPosition(span.start)
    const finish = source.getLineAndCharacterOfPosition(span.finish)

    return `pos/end ${span.pos}/${span.end} start ${span.start} (${start.line + 1}:${start.character + 1}) end ${span.finish} (${finish.line + 1}:${finish.character + 1}) pos-line ${pos.line + 1}:${pos.character + 1}`
}
