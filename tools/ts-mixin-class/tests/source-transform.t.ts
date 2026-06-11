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

it("keeps an imported class-level @mixin() marker decorator untouched", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass {}
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)
    const sourceClass     = findClass(transformedFile, "SourceClass")

    t.equal(transformedFile, sourceFile, "Returns the original SourceFile instance")
    t.equal(ts.getDecorators(sourceClass)?.length ?? 0, 1, "Mixin marker decorator is preserved")
    t.true(printSourceFile(ts, transformedFile).includes("@mixin"), "Printed output keeps the mixin marker")
})

it("supports aliased and namespace decorator imports", async (t: Test) => {
    t.equal(countClassDecorators(transformSourceFile(ts, createSourceFile(`
        import { mixin as mix } from "ts-mixin-class"

        @mix()
        class SourceClass {}
    `))), 1, "Aliased import marker is preserved")

    t.equal(countClassDecorators(transformSourceFile(ts, createSourceFile(`
        import * as MixinClass from "ts-mixin-class"

        @MixinClass.mixin()
        class SourceClass {}
    `))), 1, "Namespace import marker is preserved")
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

    t.equal(countClassDecorators(transformedFile), 1, "Custom marker is preserved")
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
