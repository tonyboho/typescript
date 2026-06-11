import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, findFirst } from "./util.js"

it("keeps unrelated source files untouched", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        class SourceClass {
            value: string = "ok"
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Returns the original SourceFile instance")
})

it("does not treat a local @mixin() decorator as the package marker", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        function mixin(): (..._args: unknown[]) => void {
            return () => {}
        }

        @mixin()
        class SourceClass {}
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Local decorator is ignored")
})

it("removes an imported class-level @mixin() marker decorator", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass {}
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)
    const sourceClass     = findClass(transformedFile, "SourceClass")

    t.not.equal(transformedFile, sourceFile, "Returns a transformed SourceFile instance")
    t.equal(ts.getDecorators(sourceClass)?.length ?? 0, 0, "Mixin marker decorator is consumed")
    t.false(printSourceFile(ts, transformedFile).includes("@mixin"), "Printed output has no mixin marker")
})

it("supports aliased and namespace decorator imports", async (t: Test) => {
    t.equal(countClassDecorators(transformSourceFile(ts, createSourceFile(`
        import { mixin as mix } from "ts-mixin-class"

        @mix()
        class SourceClass {}
    `))), 0, "Aliased import marker is consumed")

    t.equal(countClassDecorators(transformSourceFile(ts, createSourceFile(`
        import * as MixinClass from "ts-mixin-class"

        @MixinClass.mixin()
        class SourceClass {}
    `))), 0, "Namespace import marker is consumed")
})

it("supports custom package and decorator options", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { compose } from "custom-mixin-package"

        @compose()
        class SourceClass {}
    `), {
        decoratorName : "compose",
        packageName   : "custom-mixin-package"
    })

    t.equal(countClassDecorators(transformedFile), 0, "Custom marker is consumed")
})

function findClass(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration {
    const sourceClass = findFirst(sourceFile, (node): node is ts.ClassDeclaration => {
        return ts.isClassDeclaration(node) && node.name?.text === name
    })

    if (sourceClass === undefined) {
        throw new Error(`Cannot find class ${name}`)
    }

    return sourceClass
}

function countClassDecorators(sourceFile: ts.SourceFile): number {
    return ts.getDecorators(findClass(sourceFile, "SourceClass"))?.length ?? 0
}
