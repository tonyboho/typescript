import { Base, mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

class ConstructableBase extends Base {
    public baseValue: string = "base"
    skippedBaseValue: string = "skipped"
}

@mixin()
class ConstructableMixin {
    public mixinValue: number = 0
    skippedMixinValue: number = -1

    mixinMethod(): number {
        return this.mixinValue
    }
}

class ConstructableConsumer extends ConstructableBase implements ConstructableMixin {
    public ownValue: boolean = false
    skippedOwnValue: boolean = false
}

class GenericBase<T> extends Base {
    public genericBaseValue: T | undefined
    skippedGenericBaseValue: T | undefined
}

@mixin()
class GenericMixin<T> {
    public genericMixinValue: T | undefined
    skippedGenericMixinValue: T | undefined

    genericMixinMethod(): T | undefined {
        return this.genericMixinValue
    }
}

class GenericConsumer<T> extends GenericBase<T> implements GenericMixin<T> {
    public genericOwnValue: T | undefined
    skippedGenericOwnValue: T | undefined
}

const constructed = ConstructableConsumer.new({
    baseValue  : "configured",
    mixinValue : 42,
    ownValue   : true
})

const t1: string = constructed.baseValue
const t2: number = constructed.mixinValue
const t3: boolean = constructed.ownValue
const t4: number = constructed.mixinMethod()

// @ts-expect-error Base.new config excludes methods.
ConstructableConsumer.new({ mixinMethod : () => 1 })

// @ts-expect-error Base.new config rejects unknown properties.
ConstructableConsumer.new({ missingValue : "nope" })

// @ts-expect-error public-only construction config excludes fields without an explicit public modifier.
ConstructableConsumer.new({ skippedOwnValue : true })

const genericConstructed = GenericConsumer.new({
    genericBaseValue  : "base",
    genericMixinValue : "mixin",
    genericOwnValue   : "own"
})

const t5: string | undefined = genericConstructed.genericBaseValue
const t6: string | undefined = genericConstructed.genericMixinValue
const t7: string | undefined = genericConstructed.genericOwnValue

// @ts-expect-error Generic config infers T = string.
const e1: number | undefined = genericConstructed.genericMixinValue

// @ts-expect-error Generated static config excludes methods.
GenericConsumer.new({ genericMixinMethod : () => "x" })

// @ts-expect-error public-only construction config excludes generic fields without an explicit public modifier.
GenericConsumer.new({ skippedGenericMixinValue : "x" })

it("constructs consumers through Base.new config objects", async (t: Test) => {
    t.true(constructed instanceof ConstructableConsumer, "Base.new returns the consumer instance")
    t.true(constructed instanceof ConstructableBase, "Base.new keeps the explicit base")
    t.true(constructed instanceof ConstructableMixin, "Base.new keeps consumed mixin instanceof")
    t.equal(constructed.baseValue, "configured", "Base config property is assigned")
    t.equal(constructed.mixinValue, 42, "Mixin config property is assigned")
    t.equal(constructed.ownValue, true, "Consumer config property is assigned")
    t.equal(constructed.mixinMethod(), 42, "Mixin methods work after Base.new initialization")

    t.true(genericConstructed instanceof GenericConsumer, "Generated static new returns a generic consumer")
    t.equal(genericConstructed.genericBaseValue, "base", "Generic base config property is assigned")
    t.equal(genericConstructed.genericMixinValue, "mixin", "Generic mixin config property is assigned")
    t.equal(genericConstructed.genericOwnValue, "own", "Generic consumer config property is assigned")
})

void [ t1, t2, t3, t4, t5, t6, t7, e1 ]
