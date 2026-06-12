import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { RequiredBase, RequiredMixin, SourceClass1, SourceClass2 } from "./mixins.js"


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

        this.value1 = "value1"

        super.value2 = "value2"

        return super.method1()
    }

    methodBase(): A2 {
        return super.baseMethod()
    }
}

class RequiredConsumerBase extends RequiredBase {
    override requiredMethod(): string {
        return "consumerBase/" + super.requiredMethod()
    }
}

class RequiredConsumer extends RequiredConsumerBase implements RequiredMixin {
    ownRequired(): string {
        return super.requiredMixinMethod()
    }
}


it("basic", async (t: Test) => {
    const instance = new Consumer(42)
    const required = new RequiredConsumer()

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

    t.equal(required.requiredMixinMethod(), "consumerBase/requiredBase/requiredMixin", "Imported required-base mixin uses the concrete base")
    t.equal(required.ownRequired(), "consumerBase/requiredBase/requiredMixin", "Imported required-base mixin is available through super")
    t.equal(RequiredConsumer.staticRequired(), "staticRequired", "Imported required-base consumer keeps base statics")
    t.equal(RequiredConsumer.staticRequiredMixin(), "staticRequiredMixin", "Imported required-base consumer keeps mixin statics")
    t.true(required instanceof RequiredMixin, "Imported required-base consumer matches the mixin")
    t.true(required instanceof RequiredBase, "Imported required-base consumer keeps the required base")
})
