import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, findFirst, trimIndent, typecheckText } from "./util.js"

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

    const interfaceDeclaration = findInterface(transformedFile, "SourceClass")
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

it("transformed output typechecks, including generics, statics and super calls", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class SourceClass1<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }

            makeAnother (): SourceClass1<number> {
                return new SourceClass1<number>()
            }
        }

        @mixin()
        export class ChildMixin<T> implements SourceClass1<T> {
            childMethod (a: T): string {
                return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
            }
        }

        const direct = new SourceClass1<number>()

        const v1: number = direct.passThrough1(3)
        const v2: number = SourceClass1.staticHelper(2)
        const v3: SourceClass1<number> = direct.makeAnother()

        // @ts-expect-error дженерик T = number, строка не подходит
        const e1: number = direct.passThrough1("x")

        const child = new ChildMixin<boolean>()

        const v4: string = child.childMethod(true)
        const v5: boolean = child.passThrough1(false)

        // @ts-expect-error childMethod принимает T = boolean
        const e2: string = child.childMethod("x")

        void [v1, v2, v3, v4, v5, e1, e2]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("transformed required-base mixin output typechecks end to end", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase<T> {
            requiredValue: T

            constructor (requiredValue: T) {
                this.requiredValue = requiredValue
            }

            requiredMethod (): T {
                return this.requiredValue
            }

            static staticRequired (): string {
                return "staticRequired"
            }
        }

        class RealBase extends RequiredBase<string> {
            override requiredMethod (): string {
                return "real/" + super.requiredMethod()
            }
        }

        @mixin()
        class RequiredMixin extends RequiredBase<string> {
            mixinValue: string = "mixin"

            mixinMethod (): string {
                return super.requiredMethod() + "/" + this.mixinValue
            }

            static staticMixin (): string {
                return "staticMixin"
            }
        }

        class Consumer extends RealBase implements RequiredMixin {
            own (): string {
                return super.mixinMethod()
            }
        }

        class DefaultConsumer implements RequiredMixin {
        }

        const consumer = new Consumer("base")

        const v1: string = consumer.requiredMethod()
        const v2: string = consumer.mixinMethod()
        const v3: string = consumer.own()
        const v4: string = Consumer.staticRequired()
        const v5: string = Consumer.staticMixin()

        const defaultConsumer = new DefaultConsumer("default")
        const v6: string = defaultConsumer.requiredMethod()
        const v7: string = defaultConsumer.mixinMethod()

        // @ts-expect-error required base generic is fixed as string.
        const e1: number = consumer.requiredValue

        void [ v1, v2, v3, v4, v5, v6, v7, e1 ]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("transformed required-base mixin rejects unrelated consumer bases at typecheck time", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase {
            requiredMethod (): string { return "required" }
        }

        class UnrelatedBase {
        }

        @mixin()
        class RequiredMixin extends RequiredBase {
            mixinMethod (): string {
                return super.requiredMethod()
            }
        }

        class Consumer extends UnrelatedBase implements RequiredMixin {
        }
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.true(
        diagnostics.some((diagnostic) => {
            return diagnostic.includes("Mixin required base mismatch") &&
                diagnostic.includes("RequiredMixin") &&
                diagnostic.includes("RequiredBase")
        }),
        diagnostics.join("\n")
    )
})

it("expands a consumer class into a merged intermediate base", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        @mixin()
        class SourceClass2<A> {
            passThrough2 (a: A): A { return a }
        }

        class Base {
            baseValue: number = 42
        }

        class Consumer<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("interface __Consumer$base<A> extends SourceClass1<string>, SourceClass2<A>"),
        "Merged interface repeats the implements list verbatim")
    t.true(
        printed.includes(
            "class __Consumer$base<A> extends (mixinChain(Base, SourceClass1, SourceClass2) as unknown as " +
            "typeof Base & ClassStatics<typeof SourceClass1> & ClassStatics<typeof SourceClass2>)"
        ),
        "Intermediate base delegates the runtime chain to the helper with the statics cast"
    )
    t.true(printed.includes("class Consumer<A> extends __Consumer$base<A> implements SourceClass1<string>, SourceClass2<A>"),
        "Consumer extends the intermediate base and keeps its implements clause")
})

it("expands a consumer class without an explicit base", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        class Consumer<T> implements SourceClass1<T> {
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("class __Consumer$empty {\n}"),
        "An explicit empty base class is generated")
    t.true(
        printed.includes(
            "class __Consumer$base<T> extends (mixinChain(__Consumer$empty, SourceClass1) as unknown as " +
            "typeof __Consumer$empty & ClassStatics<typeof SourceClass1>)"
        ),
        "Helper chain starts at the generated empty base and keeps mixin statics"
    )
})

it("supports a generic consumer base class", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        class Base<T> {
            baseValue: T

            constructor (baseValue: T) {
                this.baseValue = baseValue
            }

            baseMethod (): T {
                return this.baseValue
            }
        }

        class Consumer<A> extends Base<A> implements SourceClass1<string> {
            method (): A {
                return super.baseMethod()
            }
        }

        const consumer = new Consumer<number>(42)

        const v1: number = consumer.baseValue
        const v2: number = consumer.method()
        const v3: string = consumer.passThrough1("x")

        // @ts-expect-error Base<T> is instantiated as Base<number>.
        const e1: string = consumer.baseValue

        // @ts-expect-error SourceClass1 is instantiated as SourceClass1<string>.
        const e2: number = consumer.passThrough1(1)

        void [v1, v2, v3, e1, e2]
    `))
    const printed = printSourceFile(ts, transformedFile)
    const diagnostics = typecheckText(printed)

    t.true(printed.includes("interface __Consumer$base<A> extends Base<A>, SourceClass1<string>"),
        "Merged interface includes the instantiated generic base")
    t.expect(diagnostics).toEqual([])
})

it("consumer transitively applies mixin dependencies", async (t: Test) => {
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

        class Consumer<T> implements ChildMixin<T> {
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("mixinChain(__Consumer$empty, ChildMixin)"),
        "Consumer delegates transitive dependency application to the runtime helper")
    t.true(printed.includes("interface __Consumer$base<T> extends ChildMixin<T>"),
        "Merged interface lists only the direct implements entries")
})

it("does not treat non-mixin implements entries as mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        interface PlainContract {
            contractMethod (): void
        }

        class Consumer<T> implements SourceClass1<T>, PlainContract {
            contractMethod (): void {}
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.true(printed.includes("interface __Consumer$base<T> extends SourceClass1<T> {"),
        "Merged interface contains only mixin entries")
    t.true(printed.includes("implements SourceClass1<T>, PlainContract"),
        "Consumer keeps the full implements list")
})

it("transformed consumer output typechecks end to end", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class SourceClass1<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }
        }

        @mixin()
        export class SourceClass2<A> {
            value2: string = "value2"

            passThrough2 (a: A): A { return a }

            method2 (): string { return this.value2 }
        }

        class Base {
            baseValue: number = 42

            static staticBase (): string { return "staticBase" }
        }

        class Consumer1<T, A> implements SourceClass1<T>, SourceClass2<A> {
        }

        class Consumer2<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
            method1 (): string {
                return "consumer2/" + super.method1()
            }
        }

        const c1 = new Consumer1<string, number>()

        const v1: string = c1.passThrough1("x")
        const v2: number = c1.passThrough2(1)

        // @ts-expect-error дженерик T = string
        const e1: string = c1.passThrough1(1)

        const c2 = new Consumer2<boolean>()

        const v3: string  = c2.passThrough1("fixed")
        const v4: boolean = c2.passThrough2(true)
        const v5: number  = c2.baseValue
        const v6: string  = Consumer2.staticBase()
        const v7: number  = Consumer2.staticHelper(3)

        // @ts-expect-error первый миксин зафиксирован как SourceClass1<string>
        const e2: string = c2.passThrough1(1)

        const asMixin: SourceClass1<string> = c2
        const asBase: Base = c2

        class SubConsumer<A> extends Consumer2<A> {
            method2 (): string {
                return "sub/" + super.method2()
            }
        }

        const v8: number = new SubConsumer<number>().passThrough2(7)

        void [v1, v2, v3, v4, v5, v6, v7, v8, e1, e2, asMixin, asBase]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("reports unsupported mixin class declarations", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        abstract class AbstractMixin {
        }

        @mixin()
        class ConstructorMixin {
            constructor () {}
        }

        @mixin()
        class PrivateMixin {
            private value: string = "x"
        }

        @mixin()
        class HashPrivateMixin {
            #value: string = "x"
        }

        @mixin()
        class AbstractMemberMixin {
            abstract value: string
        }

        @mixin()
        class MissingPropertyTypeMixin {
            value = "x"
        }

        @mixin()
        class MissingMethodReturnTypeMixin {
            method () {
                return "x"
            }
        }

        @mixin()
        class MissingParameterTypeMixin {
            method (value): string {
                return String(value)
            }
        }

        @mixin()
        class MissingAccessorTypeMixin {
            get value () {
                return "x"
            }
        }
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages = diagnostics.join("\n")

    t.true(messages.includes("Invalid mixin class declaration"), messages)
    t.true(messages.includes("Mixin class AbstractMixin cannot be abstract"), messages)
    t.true(messages.includes("Mixin class ConstructorMixin cannot declare a constructor"), messages)
    t.true(messages.includes("Mixin class PrivateMixin member value cannot be private or protected"), messages)
    t.true(messages.includes("Mixin class HashPrivateMixin member #value cannot use ECMAScript private names"), messages)
    t.true(messages.includes("Mixin class AbstractMemberMixin member value cannot be abstract"), messages)
    t.true(messages.includes("Mixin class MissingPropertyTypeMixin property value must have an explicit type annotation"), messages)
    t.true(messages.includes("Mixin class MissingMethodReturnTypeMixin method method must have an explicit return type annotation"), messages)
    t.true(messages.includes("Mixin class MissingParameterTypeMixin method parameter value must have an explicit type annotation"), messages)
    t.true(messages.includes("Mixin class MissingAccessorTypeMixin accessor value must have an explicit type annotation"), messages)
})

it("reports anonymous default mixin classes with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export default class {
            value: string = "x"
        }
    `))
    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages = diagnostics.join("\n")

    t.true(messages.includes("Invalid mixin class declaration"), messages)
    t.true(messages.includes("default-exported mixin class must be named"), messages)
    t.true(messages.includes("export default class MyMixin"), messages)
})

it("reports anonymous mixin consumer class declarations with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceMixin {
            value: string = "x"
        }

        export default class implements SourceMixin {
        }
    `))
    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages = diagnostics.join("\n")

    t.true(messages.includes("Invalid mixin consumer declaration"), messages)
    t.true(messages.includes("A mixin consumer class must be named"), messages)
    t.true(messages.includes("export default class Consumer"), messages)
})

it("reports unsupported mixin consumer base expressions with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        function makeBase (): new () => object {
            return class {
            }
        }

        @mixin()
        class SourceMixin {
            value: string = "x"
        }

        class Consumer extends makeBase() implements SourceMixin {
        }
    `))
    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages = diagnostics.join("\n")

    t.true(messages.includes("Unsupported mixin consumer base expression"), messages)
    t.true(messages.includes("Consumer extends makeBase()"), messages)
    t.true(messages.includes("Only named base classes such as Base or ns.Base are supported for now"), messages)
    t.true(messages.includes("assign the expression to a named class or const"), messages)
})

function findClass(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
    return findFirst(sourceFile, (node): node is ts.ClassDeclaration => {
        return ts.isClassDeclaration(node) && node.name?.text === name
    })
}

function findInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration {
    const declaration = findFirst(sourceFile, (node): node is ts.InterfaceDeclaration => {
        return ts.isInterfaceDeclaration(node) && node.name.text === name
    })

    if (declaration === undefined) {
        throw new Error(`Cannot find interface ${name}`)
    }

    return declaration
}

function findVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
    return findFirst(sourceFile, (node): node is ts.VariableDeclaration => {
        return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
    })
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

void trimIndent
