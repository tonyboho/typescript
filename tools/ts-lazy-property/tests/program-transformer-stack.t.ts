import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import transformProgram from "../src/index.js"

type TypeScriptWithParents = typeof ts & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}
type MutableNode = ts.Node & {
    flags : ts.NodeFlags
}

const sourceFileName = "source.ts"
const sourceText     = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: string = "ok"
    }

    const instance = new SourceClass()

    instance.$lazyProperty
    instance.previousVirtualProperty
`)

it("composes with a previous virtual program transformer layer", async (t: Test) => {
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
    const layeredHost = ts.createCompilerHost(compilerOptions, true)
    const layeredGetSourceFile = layeredHost.getSourceFile.bind(layeredHost)
    const originalSourceFile    = ts.createSourceFile(
        sourceFileName,
        sourceText,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
    )
    const layeredSourceFile = addPreviousVirtualProperty(originalSourceFile)

    layeredHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (fileName === sourceFileName) {
            return layeredSourceFile
        }

        return layeredGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    const layeredProgram = ts.createProgram([ sourceFileName ], compilerOptions, layeredHost)
    const finalProgram   = transformProgram(layeredProgram, compilerHost, {}, { ts })
    const finalSource    = finalProgram.getSourceFile(sourceFileName)

    if (finalSource === undefined) {
        throw new Error("Missing final source file.")
    }

    t.expect(memberSummary(findClass(finalSource, "SourceClass"))).toEqual([
        "PropertyDeclaration:$lazyProperty",
        "GetAccessor:lazyProperty",
        "SetAccessor:lazyProperty",
        "PropertyDeclaration:previousVirtualProperty"
    ])
    t.false(
        finalSource.text.includes("previousVirtualProperty: number"),
        "Previous layer declaration stays virtual and does not have to modify source text"
    )
    t.expect(formatDiagnostics(finalProgram.getSemanticDiagnostics(finalSource))).toEqual([])
    t.equal(
        typeTextAt(finalProgram, finalSource, "$lazyProperty"),
        "string | undefined",
        "Checker sees this transformer's virtual backing property"
    )
})

function addPreviousVirtualProperty(sourceFile: ts.SourceFile): ts.SourceFile {
    const transformed = ts.transform(sourceFile, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (ts.isClassDeclaration(node) && node.name?.text === "SourceClass") {
                    return context.factory.updateClassDeclaration(
                        node,
                        node.modifiers,
                        node.name,
                        node.typeParameters,
                        node.heritageClauses,
                        context.factory.createNodeArray([
                            ...node.members,
                            context.factory.createPropertyDeclaration(
                                undefined,
                                "previousVirtualProperty",
                                undefined,
                                context.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                                context.factory.createNumericLiteral(1)
                            )
                        ])
                    )
                }

                return ts.visitEachChild(node, visit, context)
            }

            return (nextSourceFile) => ts.visitNode(nextSourceFile, visit) as ts.SourceFile
        }
    ])

    try {
        const sourceFile = (ts as TypeScriptWithParents).setParentRecursive(transformed.transformed[0], false)

        clearSynthesizedFlags(sourceFile)

        return sourceFile
    } finally {
        transformed.dispose()
    }
}

function clearSynthesizedFlags(node: ts.Node): void {
    (node as MutableNode).flags &= ~ts.NodeFlags.Synthesized

    ts.forEachChild(node, (child) => {
        clearSynthesizedFlags(child)
    })
}

function findClass(sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration {
    const found = findFirst(sourceFile, (node): node is ts.ClassDeclaration => {
        return ts.isClassDeclaration(node) && node.name?.text === className
    })

    if (found === undefined) {
        throw new Error(`Cannot find class: ${className}`)
    }

    return found
}

function memberSummary(classDeclaration: ts.ClassDeclaration): string[] {
    return classDeclaration.members.map((member) => {
        return `${ts.SyntaxKind[member.kind]}:${memberNameText(member)}`
    })
}

function memberNameText(member: ts.ClassElement): string {
    if (member.name === undefined) {
        return "<none>"
    }

    if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) {
        return member.name.text
    }

    return member.name.getText()
}

function typeTextAt(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    text: string
): string {
    const node = findPropertyAccessName(sourceFile, text)

    if (node === undefined) {
        throw new Error(`Cannot find property access: ${text}`)
    }

    const checker = program.getTypeChecker()
    const symbol  = checker.getSymbolAtLocation(node)

    if (symbol === undefined) {
        throw new Error(`Cannot resolve property symbol: ${text}`)
    }

    return checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, node))
}

function findPropertyAccessName(
    sourceFile: ts.SourceFile,
    text: string
): ts.Identifier | undefined {
    return findFirst(sourceFile, (node): node is ts.Identifier => {
        return ts.isIdentifier(node) && node.text === text && ts.isPropertyAccessExpression(node.parent)
    })
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
    return diagnostics.map((diagnostic) => {
        const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0)

        return [
            `TS${diagnostic.code}`,
            position === undefined ? "?:?" : `${position.line + 1}:${position.character + 1}`,
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ].join(" ")
    })
}

function findFirst<Node extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is Node
): Node | undefined {
    let found: Node | undefined

    const visit = (node: ts.Node): void => {
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

function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}
