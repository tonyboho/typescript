import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, findClass, findInterface, findVariable, typecheckText } from "./util.js"

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

it("expands an imported class-level @mixin() class into interface + factory + const", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class SourceClass<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    const interfaceDeclaration = requiredInterface(transformedFile, "SourceClass")
    const interfaceMembers     = interfaceDeclaration.members.map((member) => memberName(member))

    t.equal(findClass(transformedFile, "SourceClass"), undefined, "Original class declaration is replaced")
    t.expect(interfaceMembers).toEqual([ "value1", "passThrough1", "method1" ])
    t.equal(interfaceDeclaration.typeParameters?.length, 1, "Interface keeps the class type parameters")
    t.true(hasExportModifier(interfaceDeclaration), "Interface keeps the export modifier")

    t.true(findVariable(transformedFile, "__SourceClass$mixin") !== undefined, "Mixin factory is generated")
    t.true(findVariable(transformedFile, "SourceClass") !== undefined, "Value const is generated")

    t.false(printed.includes("@mixin"), "Marker decorator is removed")
    t.true(
        printed.includes(
            "import { defineMixinClass, mixinChain, type AnyConstructor, type ClassStatics, " +
            "type MixinFactory, type RuntimeMixinClass } from \"ts-mixin-class\""
        ),
        "Helper import is added"
    )
    t.true(printed.includes("function <T>(base: AnyConstructor)"),
        "Factory takes a typed base")
    t.true(printed.includes("return class extends base"),
        "Factory takes a base and returns an anonymous class expression")
    t.true(printed.includes("static staticHelper"), "Static members stay in the factory body")
    t.false(printedInterface(printed).includes("staticHelper"), "Static members are not in the interface")
    t.true(
        printed.includes(
            "defineMixinClass(\"SourceClass\", __SourceClass$mixin as unknown as MixinFactory, []) as unknown as " +
            "(new <T>(...args: any[]) => SourceClass<T>) & " +
            "ClassStatics<ReturnType<typeof __SourceClass$mixin>> & RuntimeMixinClass"
        ),
        "Value const registers the factory with the runtime helper and keeps the declarative cast"
    )
})

it("expands a named default-exported mixin class", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export default class DefaultMixin {
            value: string = "default"

            method (): string {
                return this.value
            }
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("interface DefaultMixin"), "Default mixin interface is generated")
    t.true(printed.includes("export const __DefaultMixin$mixin"), "Default mixin factory is exported for generated imports")
    t.true(printed.includes("const DefaultMixin = defineMixinClass"), "Default mixin value stays local")
    t.true(printed.includes("export default DefaultMixin"), "Default export points at the generated runtime value")
    t.false(printed.includes("export const DefaultMixin ="), "Default mixin is not accidentally exported as a named value")
    t.expect(typecheckText(printed)).toEqual([])
})

it("supports aliased and namespace decorator imports", async (t: Test) => {
    const aliased = transformSourceFile(ts, createSourceFile(`
        import { mixin as mix } from "ts-mixin-class"

        @mix()
        class SourceClass {
            value: string = "ok"
        }
    `))

    t.true(findInterface(aliased, "SourceClass") !== undefined, "Aliased import marker expands the class")

    const namespaced = transformSourceFile(ts, createSourceFile(`
        import * as MixinClass from "ts-mixin-class"

        @MixinClass.mixin()
        class SourceClass {
            value: string = "ok"
        }
    `))

    t.true(findInterface(namespaced, "SourceClass") !== undefined, "Namespace import marker expands the class")
})

it("supports custom package and decorator options", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { compose } from "custom-mixin-package"

        @compose()
        class SourceClass {
            value: string = "ok"
        }
    `), {
        decoratorName : "compose",
        packageName   : "custom-mixin-package"
    })

    t.true(findInterface(transformedFile, "SourceClass") !== undefined, "Custom marker expands the class")
    t.true(
        printSourceFile(ts, transformedFile)
            .includes(
                "import { defineMixinClass, mixinChain, type AnyConstructor, type ClassStatics, " +
                "type MixinFactory, type RuntimeMixinClass } from \"custom-mixin-package\""
            ),
        "Helper import uses the custom package name"
    )
})

it("expands a dependent mixin with a typed base and a dependency chain", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        @mixin()
        class ChildMixin<T> implements SourceClass1<T> {
            childMethod (a: T): string { return String(super.passThrough1(a)) }
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("function <T>(base: AnyConstructor<SourceClass1<T>>)"),
        "Dependent mixin base parameter is typed with the dependency")
    t.true(printed.includes("return class extends base"),
        "Dependent mixin factory returns an anonymous class expression")
    t.true(printed.includes("defineMixinClass(\"ChildMixin\", __ChildMixin$mixin as unknown as MixinFactory, [SourceClass1])"),
        "Value const registers the direct dependency with the runtime helper")
    t.true(printed.includes("interface ChildMixin<T> extends SourceClass1<T>"),
        "Generated interface extends the dependency")
})

it("expands a mixin required base declared with extends", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase {
            requiredMethod (): string { return "required" }
        }

        @mixin()
        class RequiredMixin extends RequiredBase {
            mixinMethod (): string { return super.requiredMethod() }
        }

        class RealBase extends RequiredBase {
            override requiredMethod (): string { return "real" }
        }

        class Consumer extends RealBase implements RequiredMixin {
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("interface RequiredMixin extends RequiredBase"),
        "Generated interface keeps the required base as an instance constraint")
    t.true(printed.includes("function (base: AnyConstructor<RequiredBase>)"),
        "Mixin factory parameter is constrained to the required base")
    t.true(printed.includes("defineMixinClass(\"RequiredMixin\", __RequiredMixin$mixin as unknown as MixinFactory, [], RequiredBase)"),
        "Value const registers the required runtime base")
    t.true(printed.includes("class __Consumer$base<__mixinRequiredBase0 extends never>"),
        "Consumer base carries a required-base constraint for diagnostics")
    t.true(printed.includes("extends (mixinChain(RealBase, RequiredMixin)"),
        "Consumer still supplies its concrete descendant base to the runtime chain")
    t.true(printed.includes("class Consumer extends __Consumer$base<RealBase extends RequiredBase ? never :"),
        "Consumer maps required-base diagnostics to the original extends heritage")
    t.true(printed.includes("Mixin required base mismatch."),
        "Consumer required-base diagnostic carries a custom message")
})

function requiredInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration {
    const declaration = findInterface(sourceFile, name)

    if (declaration === undefined) {
        throw new Error(`Cannot find interface ${name}`)
    }

    return declaration
}

function memberName(member: ts.TypeElement): string {
    if (member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
        return member.name.text
    }

    throw new Error("Unexpected interface member name")
}

function hasExportModifier(node: ts.InterfaceDeclaration): boolean {
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function printedInterface(printed: string): string {
    const start = printed.indexOf("interface ")
    const end   = printed.indexOf("}", start)

    return printed.slice(start, end + 1)
}
