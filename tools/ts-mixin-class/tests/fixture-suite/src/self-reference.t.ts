import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

@mixin()
class SourceClass1<T> {
    value1: string = "value1"

    passThrough1(a: T): T {
        return a
    }

    method1(): string {
        return this.value1
    }

    makeAnother(): SourceClass1<number> {
        return new SourceClass1<number>()
    }
}

@mixin()
class ChildMixin<T> implements SourceClass1<T> {
    childMethod(a: T): string {
        return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
    }
}

class Base {
    baseValue: number = 42
}

class Consumer<A> extends Base implements ChildMixin<A> {
}

const c = new Consumer<boolean>()

const t1: string = c.childMethod(true)
const t2: boolean = c.passThrough1(false)

const another = c.makeAnother()
const t3: number = another.passThrough1(5)

// @ts-expect-error makeAnother returns SourceClass1<number>.
const e1: string = another.passThrough1(5)

// @ts-expect-error childMethod accepts A = boolean.
const e2: string = c.childMethod("x")

it("self-reference", async (t: Test) => {
    t.equal(c.childMethod(true), "child/true/value1", "super calls in dependent mixin body work")
    t.equal(c.baseValue, 42, "Consumer gets base field")

    const fresh = c.makeAnother()

    t.equal(fresh.value1, "value1", "Self-created instance has mixin fields")
    t.false("baseValue" in fresh, "Self-created instance does not drag consumer base")
    t.true(fresh instanceof SourceClass1, "Self-created instance is an instance of the outer mixin const")
})

void [ t1, t2, t3, e1, e2, another, ChildMixin ]
