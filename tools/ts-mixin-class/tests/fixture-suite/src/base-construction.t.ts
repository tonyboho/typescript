import { Base, mixin, type Config } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

type Assert<T extends true> = T

type Equal<Left, Right> =
    (<T>() => T extends Left ? 1 : 2) extends
        (<T>() => T extends Right ? 1 : 2)
        ? true
        : false

class ConfigShapeModel extends Base {
    public firstName: string = ""
    public lastName: string = ""

    fullName(): string {
        return `${this.firstName} ${this.lastName}`.trim()
    }

    override initialize(config?: Config<this>): void {
        super.initialize(config)
    }
}

type ConfigShapeModelConfig = Config<ConfigShapeModel>
type ConfigShapeModelConfigKeys = keyof ConfigShapeModelConfig
type ConfigShapeModelConfigHasExpectedKeys = Assert<Equal<
    ConfigShapeModelConfigKeys,
    "firstName" | "lastName"
>>

const configShapeOk: ConfigShapeModelConfig = {
    firstName : "Ada",
    lastName  : "Lovelace"
}

// @ts-expect-error Config helper excludes methods from the config object.
const configShapeRejectsMethods: ConfigShapeModelConfig = { fullName : () => "Ada Lovelace" }

// @ts-expect-error Config helper rejects properties that are not on the instance data shape.
const configShapeRejectsUnknown: ConfigShapeModelConfig = { age : 36 }

class ConstructableBase extends Base {
    public baseValue: string = "base"
    public optionalBaseValue?: string
    skippedBaseValue: string = "skipped"
}

@mixin()
class ConstructableMixin {
    public mixinValue: number = 0
    public optionalMixinValue?: number
    skippedMixinValue: number = -1

    mixinMethod(): number {
        return this.mixinValue
    }
}

class ConstructableConsumer extends ConstructableBase implements ConstructableMixin {
    public ownValue: boolean = false
    public optionalOwnValue?: boolean
    public definiteOwnValue!: string
    skippedOwnValue: boolean = false
    initializedLabel: string = ""

    override initialize(config?: Config<this>): void {
        super.initialize(config)

        this.initializedLabel = `${this.baseValue}/${this.mixinValue}/${this.ownValue}`
    }
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

@mixin()
class GenericContainerMixin {
    public touched: boolean = false
}

class GenericContainer<T> extends Base implements GenericContainerMixin {
    public item: T | undefined
}

const constructed = ConstructableConsumer.new({
    baseValue           : "configured",
    definiteOwnValue    : "definite",
    mixinValue          : 42,
    optionalBaseValue   : "optional-base",
    optionalMixinValue  : 43,
    optionalOwnValue    : true,
    ownValue            : true
})

const t1: string = constructed.baseValue
const t2: number = constructed.mixinValue
const t3: boolean = constructed.ownValue
const t4: number = constructed.mixinMethod()
const t5: string = constructed.initializedLabel
const t6: string = constructed.definiteOwnValue
const t7: string | undefined = constructed.optionalBaseValue
const t8: number | undefined = constructed.optionalMixinValue
const t9: boolean | undefined = constructed.optionalOwnValue

// @ts-expect-error Base.new config excludes methods.
ConstructableConsumer.new({ mixinMethod : () => 1 })

// @ts-expect-error Base.new config rejects unknown properties.
ConstructableConsumer.new({ missingValue : "nope" })

// @ts-expect-error public-only construction config excludes fields without an explicit public modifier.
ConstructableConsumer.new({ skippedOwnValue : true })

// @ts-expect-error public-only construction config requires public fields without a question mark.
ConstructableConsumer.new({
    baseValue  : "configured",
    mixinValue : 42,
    ownValue   : true
})

ConstructableConsumer.new({
    baseValue        : "configured",
    definiteOwnValue : "definite",
    mixinValue       : 42,
    ownValue         : true
})

const genericConstructed = GenericConsumer.new({
    genericBaseValue  : "base",
    genericMixinValue : "mixin",
    genericOwnValue   : "own"
})

const t10: string | undefined = genericConstructed.genericBaseValue
const t11: string | undefined = genericConstructed.genericMixinValue
const t12: string | undefined = genericConstructed.genericOwnValue

// @ts-expect-error Generic config infers T = string.
const e1: number | undefined = genericConstructed.genericMixinValue

// @ts-expect-error Generated static config excludes methods.
GenericConsumer.new({ genericMixinMethod : () => "x" })

// @ts-expect-error public-only construction config excludes generic fields without an explicit public modifier.
GenericConsumer.new({ skippedGenericMixinValue : "x" })

const stringContainer = GenericContainer.new({
    item    : "value",
    touched : true
})

const t13: string | undefined = stringContainer.item
const t14: boolean = stringContainer.touched

// @ts-expect-error GenericContainer.new infers T = string from the item config property.
const e2: number | undefined = stringContainer.item

const numberContainer = GenericContainer.new<number>({
    item    : 1,
    touched : false
})

const t15: number | undefined = numberContainer.item

// @ts-expect-error Explicit GenericContainer.new<number> rejects string item config.
GenericContainer.new<number>({ item : "value" })

const inferredNumberContainer = GenericContainer.new({
    item    : 2,
    touched : true
})

const t16: number | undefined = inferredNumberContainer.item

// @ts-expect-error GenericContainer.new infers T = number from the item config property.
const e3: string | undefined = inferredNumberContainer.item

it("constructs consumers through Base.new config objects", async (t: Test) => {
    t.true(constructed instanceof ConstructableConsumer, "Base.new returns the consumer instance")
    t.true(constructed instanceof ConstructableBase, "Base.new keeps the explicit base")
    t.true(constructed instanceof ConstructableMixin, "Base.new keeps consumed mixin instanceof")
    t.equal(constructed.baseValue, "configured", "Base config property is assigned")
    t.equal(constructed.mixinValue, 42, "Mixin config property is assigned")
    t.equal(constructed.ownValue, true, "Consumer config property is assigned")
    t.equal(constructed.definiteOwnValue, "definite", "Definite assignment config property is assigned")
    t.equal(constructed.optionalBaseValue, "optional-base", "Optional base config property is assigned when present")
    t.equal(constructed.optionalMixinValue, 43, "Optional mixin config property is assigned when present")
    t.equal(constructed.optionalOwnValue, true, "Optional consumer config property is assigned when present")
    t.equal(constructed.initializedLabel, "configured/42/true", "Custom initialize runs after config assignment")
    t.equal(constructed.mixinMethod(), 42, "Mixin methods work after Base.new initialization")

    t.true(genericConstructed instanceof GenericConsumer, "Generated static new returns a generic consumer")
    t.equal(genericConstructed.genericBaseValue, "base", "Generic base config property is assigned")
    t.equal(genericConstructed.genericMixinValue, "mixin", "Generic mixin config property is assigned")
    t.equal(genericConstructed.genericOwnValue, "own", "Generic consumer config property is assigned")

    t.true(stringContainer instanceof GenericContainer, "Generated static new returns a generic container")
    t.true(stringContainer instanceof GenericContainerMixin, "Generic container keeps consumed mixin instanceof")
    t.equal(stringContainer.item, "value", "Generic property is initialized through .new config")
    t.equal(stringContainer.touched, true, "Generic container mixin property is initialized through .new config")
    t.equal(numberContainer.item, 1, "Explicit generic .new type argument initializes a numeric property")
    t.equal(inferredNumberContainer.item, 2, "Generic .new type argument is inferred from numeric config")
})

void [
    configShapeOk,
    configShapeRejectsMethods,
    configShapeRejectsUnknown,
    t1,
    t2,
    t3,
    t4,
    t5,
    t6,
    t7,
    t8,
    t9,
    t10,
    t11,
    t12,
    t13,
    t14,
    t15,
    t16,
    e1,
    e2,
    e3
]
