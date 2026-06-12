import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

it("transformed mixin output typechecks, including generics, statics and super calls", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { base, factory, mixin, requirements } from "ts-mixin-class"

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
        const v4 = SourceClass1[factory]
        const v5 = SourceClass1[requirements]
        const v6 = SourceClass1[base]

        // @ts-expect-error дженерик T = number, строка не подходит
        const e1: number = direct.passThrough1("x")

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e2 = SourceClass1.$mixin

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e3 = SourceClass1.$requirements

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e4 = SourceClass1.$requiredBase

        const child = new ChildMixin<boolean>()

        const v7: string = child.childMethod(true)
        const v8: boolean = child.passThrough1(false)

        // @ts-expect-error childMethod принимает T = boolean
        const e5: string = child.childMethod("x")

        void [v1, v2, v3, v4, v5, v6, v7, v8, e1, e2, e3, e4, e5]
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

it("transformed generic consumer base output typechecks", async (t: Test) => {
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

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
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
