import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile } from "./util.js"

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

    t.match(printed, "interface __Consumer$base<A> extends SourceClass1<string>, SourceClass2<A>",
        "Merged interface repeats the implements list verbatim")
    t.match(
        printed,
        "class __Consumer$base<A> extends (mixinChain(Base, SourceClass1, SourceClass2) as unknown as " +
            "typeof Base & ClassStatics<typeof SourceClass1> & ClassStatics<typeof SourceClass2>)",
        "Intermediate base delegates the runtime chain to the helper with the statics cast"
    )
    t.match(printed, "class Consumer<A> extends __Consumer$base<A> implements SourceClass1<string>, SourceClass2<A>",
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

    t.match(printed, "class __Consumer$empty {\n}",
        "An explicit empty base class is generated")
    t.match(
        printed,
        "class __Consumer$base<T> extends (mixinChain(__Consumer$empty, SourceClass1) as unknown as " +
            "typeof __Consumer$empty & ClassStatics<typeof SourceClass1>)",
        "Helper chain starts at the generated empty base and keeps mixin statics"
    )
    t.notMatch(printed, "mixinChain(Object, SourceClass1)",
        "Helper chain does not use Object as the implicit consumer base")
})

it("emits a generic consumer base class", async (t: Test) => {
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
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "interface __Consumer$base<A> extends Base<A>, SourceClass1<string>",
        "Merged interface includes the instantiated generic base")
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

    t.match(printed, "mixinChain(__Consumer$empty, ChildMixin)",
        "Consumer delegates transitive dependency application to the runtime helper")
    t.match(printed, "interface __Consumer$base<T> extends ChildMixin<T>",
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

    t.match(printed, "interface __Consumer$base<T> extends SourceClass1<T> {",
        "Merged interface contains only mixin entries")
    t.match(printed, "implements SourceClass1<T>, PlainContract",
        "Consumer keeps the full implements list")
})

it("generates public-only static construction config overloads by default", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            public baseValue: T | undefined
            public optionalBaseValue?: T
            skippedBaseValue: T | undefined
        }

        @mixin()
        class SourceClass<T> {
            public mixinValue: T | undefined
            public optionalMixinValue?: T
            skippedMixinValue: T | undefined
            mixinMethod (): T | undefined { return this.mixinValue }
        }

        class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            public ownValue: T | undefined
            public optionalOwnValue?: T
            skippedOwnValue: T | undefined
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "static new<T>(props?: Pick<Consumer<T>, \"baseValue\" | \"mixinValue\" | \"ownValue\"> & " +
            "Partial<Pick<Consumer<T>, \"optionalBaseValue\" | \"optionalMixinValue\" | \"optionalOwnValue\">>): Consumer<T>;",
        "Default public-only construction config preserves required and optional property names"
    )
    t.notMatch(printed, "\"mixinMethod\"",
        "Generated construction config does not include methods")
    t.notMatch(printed, "\"skippedBaseValue\"",
        "Public-only construction config ignores base fields without an explicit public modifier")
    t.notMatch(printed, "\"skippedMixinValue\"",
        "Public-only construction config ignores mixin fields without an explicit public modifier")
    t.notMatch(printed, "\"skippedOwnValue\"",
        "Public-only construction config ignores consumer fields without an explicit public modifier")
})

it("can use instance-type construction config mode", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            baseValue: T | undefined
        }

        @mixin()
        class SourceClass<T> {
            mixinValue: T | undefined
        }

        class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            ownValue: T | undefined
        }
    `), {
        constructionConfig : "instance-type"
    })
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "static new<T>(props?: Partial<Consumer<T>>): Consumer<T>;",
        "Instance-type construction config mode uses the whole consumer instance shape")
    t.notMatch(printed, "Pick<Consumer<T>",
        "Instance-type construction config mode skips static public-property collection")
})
