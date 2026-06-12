import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { SourceClass1, SourceClass2 } from "./mixins.js"

class Base {
    baseValue: number = 42

    baseMethod(): string {
        return "base"
    }

    static staticBase(): string {
        return "staticBase"
    }
}

class NoBaseConsumer<T, A> implements SourceClass1<T>, SourceClass2<A> {
}

class BaseConsumer<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
    method1(): string {
        return "consumer/" + super.method1()
    }
}

class SubConsumer<A> extends BaseConsumer<A> {
    method2(): string {
        return "sub/" + super.method2()
    }
}

const noBase = new NoBaseConsumer<string, number>()

const t1: string = noBase.passThrough1("x")
const t2: number = noBase.passThrough2(1)
const t3: string = noBase.value1

// @ts-expect-error T = string, number does not fit.
const e1: string = noBase.passThrough1(1)

const baseConsumer = new BaseConsumer<boolean>()

const t4: string  = baseConsumer.passThrough1("fixed")
const t5: boolean = baseConsumer.passThrough2(true)
const t6: number  = baseConsumer.baseValue
const t7: string  = BaseConsumer.staticBase()

// @ts-expect-error First mixin is fixed as SourceClass1<string>.
const e2: string = baseConsumer.passThrough1(1)

const asMixin1: SourceClass1<string> = baseConsumer
const asMixin2: SourceClass2<number> = noBase
const asBase: Base = baseConsumer

const sub = new SubConsumer<number>()
const t8: number = sub.passThrough2(7)

it("heritage", async (t: Test) => {
    t.equal(noBase.value1, "value1", "No-base consumer gets field from mixin 1")
    t.equal(noBase.value2, "value2", "No-base consumer gets field from mixin 2")
    t.equal(noBase.method1(), "value1", "No-base consumer mixin method works")

    t.equal(baseConsumer.method1(), "consumer/value1", "Consumer super.method1() reaches mixin")
    t.equal(baseConsumer.method2(), "value2", "Consumer mixin 2 method works")
    t.equal(baseConsumer.baseValue, 42, "Consumer gets base field")
    t.equal(BaseConsumer.staticBase(), "staticBase", "Consumer inherits base statics")

    t.equal(sub.method2(), "sub/value2", "SubConsumer super chain works")
    t.true(sub instanceof BaseConsumer, "SubConsumer remains instanceof consumer")
    t.true(sub instanceof Base, "SubConsumer remains instanceof explicit base")
})

void [ t1, t2, t3, t4, t5, t6, t7, t8, e1, e2, asMixin1, asMixin2, asBase ]
