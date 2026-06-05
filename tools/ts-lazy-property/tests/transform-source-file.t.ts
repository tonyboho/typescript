import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"

it("keeps unrelated source files untouched", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        class SourceClass {
            value: string = "ok"
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Returns the original SourceFile instance")
})

it("does not treat a local @lazy() decorator as the package macro", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        function lazy(): (..._args: unknown[]) => void {
            return () => {}
        }

        class SourceClass {
            @lazy()
            lazyProperty: Map<number, string> = new Map()
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Local decorator is ignored")
})

it("does not expand an imported @lazy decorator unless it is called", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        import { lazy } from "ts-lazy-property"

        class SourceClass {
            @lazy
            lazyProperty: Map<number, string> = new Map()
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Bare decorator is ignored")
})

it("expands a named @lazy() import into backing property, getter, and setter", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        import { lazy } from "ts-lazy-property"

        class SourceClass {
            @lazy()
            lazyProperty: Map<number, string> = new Map()
            regularProperty: string = "ok"
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)
    const sourceClass     = findClass(transformedFile, "SourceClass")

    t.not.equal(transformedFile, sourceFile, "Returns a transformed SourceFile instance")
    t.expect(memberSummary(sourceClass)).toEqual([
        "PropertyDeclaration:$lazyProperty",
        "GetAccessor:lazyProperty",
        "SetAccessor:lazyProperty",
        "PropertyDeclaration:regularProperty"
    ])

    const backingMember = sourceClass.members[0] as ts.PropertyDeclaration

    t.equal(
        transformedFile.text.slice(backingMember.name.getStart(transformedFile), backingMember.name.getEnd()),
        "lazyProperty",
        "Backing property name maps to original property name text"
    )
    t.equal(backingMember.name.pos, backingMember.name.getStart(transformedFile), "Backing name pos is normalized to token start")
})

it("supports aliased and namespace decorator imports", async (t: Test) => {
    t.expect(memberSummary(transformAndFindClass(`
        import { lazy as delayed } from "ts-lazy-property"

        class SourceClass {
            @delayed()
            lazyProperty: Map<number, string> = new Map()
        }
    `))).toEqual([
        "PropertyDeclaration:$lazyProperty",
        "GetAccessor:lazyProperty",
        "SetAccessor:lazyProperty"
    ])

    t.expect(memberSummary(transformAndFindClass(`
        import * as LazyProperty from "ts-lazy-property"

        class SourceClass {
            @LazyProperty.lazy()
            lazyProperty: Map<number, string> = new Map()
        }
    `))).toEqual([
        "PropertyDeclaration:$lazyProperty",
        "GetAccessor:lazyProperty",
        "SetAccessor:lazyProperty"
    ])
})

it("prints the transformed AST for emit", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { lazy } from "ts-lazy-property"

        class SourceClass {
            @lazy()
            lazyProperty: Map<number, string> = new Map()
        }
    `))
    const text            = printSourceFile(ts, transformedFile)

    t.true(text.includes("$lazyProperty: Map<number, string> | undefined = undefined"), "Prints backing property")
    t.true(text.includes("get lazyProperty(): Map<number, string>"), "Prints getter")
    t.true(text.includes("set lazyProperty(value: Map<number, string>)"), "Prints setter")
    t.false(text.includes("@lazy"), "Decorator is removed from emitted source")
})

it("reports unsupported lazy properties early", async (t: Test) => {
    await t.throws(() => transformSourceFile(ts, createSourceFile(`
        import { lazy } from "ts-lazy-property"

        class SourceClass {
            @lazy()
            lazyProperty = new Map()
        }
    `)), /must have an explicit type/, "Requires an explicit type")

    await t.throws(() => transformSourceFile(ts, createSourceFile(`
        import { lazy } from "ts-lazy-property"

        class SourceClass {
            @lazy()
            lazyProperty: Map<number, string>
        }
    `)), /must have an initializer/, "Requires an initializer")
})

function createSourceFile(text: string): ts.SourceFile {
    return ts.createSourceFile(
        "source.ts",
        trimIndent(text),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS
    )
}

function transformAndFindClass(text: string): ts.ClassDeclaration {
    return findClass(transformSourceFile(ts, createSourceFile(text)), "SourceClass")
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
