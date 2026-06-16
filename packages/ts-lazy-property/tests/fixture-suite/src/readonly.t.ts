import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    readonly lazyProperty: string = "ok"
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkTypes(instance: SourceClass): void {
    const lazyValue: string = instance.lazyProperty
    const backingValue: string | undefined = instance.$lazyProperty

    instance.$lazyProperty = backingValue
    instance.$lazyProperty = undefined

    // @ts-expect-error Readonly lazy property has no generated setter.
    instance.lazyProperty = "changed"

    // @ts-expect-error The public readonly property keeps the source type.
    const numberValue: number = instance.lazyProperty
}

it("readonly lazy property", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(instance.$lazyProperty, undefined, "Readonly backing property is undefined before access")
    t.equal(instance.lazyProperty, "ok", "Reads readonly lazy property")
    t.equal(instance.$lazyProperty, "ok", "Readonly backing property is set after access")

    instance.$lazyProperty = undefined

    t.equal(instance.lazyProperty, "ok", "Readonly lazy property can be reset through backing property")
})
