import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { SourceClass1, SourceClass2 } from "./mixins.js"


class Base<T> {
    baseValue: T

    constructor(baseValue: T) {
        this.baseValue = baseValue
    }

    baseMethod(): T {
        return this.baseValue
    }

    static staticMethod(): string {
        return "staticMethod"
    }
}

class Consumer<A2> extends Base<A2> implements SourceClass1<string>, SourceClass2<A2> {
    method1(): string {
        return super.method1()
    }

    methodBase(): A2 {
        return super.baseMethod()
    }
}


it("basic", async (t: Test) => {
    const instance = new Consumer(42)

    t.equal(instance.value1, "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.value2, "value2", "Class decorated with @mixin() compiles and runs")

    t.equal(instance.baseValue, 42, "Generic base field is preserved")
    t.equal(instance.methodBase(), 42, "Generic base super method is preserved")

    t.equal(instance.method1(), "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.method2(), "value2", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.passThrough1("typed"), "typed", "Imported generic mixin type argument is preserved")
    t.equal(instance.passThrough2(42), 42, "Imported generic consumer type argument is preserved")

    t.equal(Consumer.staticMethod1(), "staticMethod1", "Class decorated with @mixin() compiles and runs")
    t.equal(Consumer.staticMethod2(), "staticMethod2", "Class decorated with @mixin() compiles and runs")
})
