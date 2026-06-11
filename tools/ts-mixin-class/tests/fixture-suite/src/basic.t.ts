import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

@mixin()
class SourceClass1<A1> {
    value1: string = "value1"

    passThrough1 (a: A1): A1 {
        return a
    }

    method1(): string {
        return this.value1
    }

    static staticMethod1(): string {
        return "staticMethod1"
    }
}

@mixin()
class SourceClass2<A2> {
    value2: string = "value2"

    passThrough2 (a: A2): A2 {
        return a
    }

    method2(): string {
        return this.value2
    }

    static staticMethod2(): string {
        return "staticMethod2"
    }
}


class Base {
    static staticMethod(): string {
        return "staticMethod"
    }
}

class Consumer<A2> extends Base implements SourceClass1<string>, SourceClass2<A2> {
    value1: string = "value1"
    value2: string = "value2"

    method1(): string {
        return super.method1()
    }
}


it("basic", async (t: Test) => {
    const instance = new Consumer()

    t.equal(instance.value1, "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.value2, "value2", "Class decorated with @mixin() compiles and runs")

    t.equal(instance.method1(), "value1", "Class decorated with @mixin() compiles and runs")
    t.equal(instance.method2(), "value2", "Class decorated with @mixin() compiles and runs")

    t.equal(Consumer.staticMethod1(), "staticMethod1", "Class decorated with @mixin() compiles and runs")
    t.equal(Consumer.staticMethod2(), "staticMethod2", "Class decorated with @mixin() compiles and runs")
})
