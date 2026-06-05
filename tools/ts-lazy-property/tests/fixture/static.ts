import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

let count = 0

class SourceClass {
    @lazy()
    static lazyProperty: string = (() => {
        count++
        return "static"
    })()
}

function checkTypes(): void {
    const lazyValue: string = SourceClass.lazyProperty
    const backingValue: string | undefined = SourceClass.$lazyProperty

    SourceClass.lazyProperty = lazyValue
    SourceClass.$lazyProperty = backingValue
    SourceClass.$lazyProperty = undefined

    // @ts-expect-error Static lazy property keeps the source type.
    const numberValue: number = SourceClass.lazyProperty
}

it("static lazy property", async (t: Test) => {
    t.equal(SourceClass.$lazyProperty, undefined, "Static backing property is undefined before access")
    t.equal(count, 0, "Static lazy initializer is not evaluated before access")

    t.equal(SourceClass.lazyProperty, "static", "Reads static lazy property")
    t.equal(SourceClass.$lazyProperty, "static", "Static backing property is set after access")
    t.equal(count, 1, "Static lazy initializer is evaluated once")

    SourceClass.$lazyProperty = undefined

    t.equal(SourceClass.lazyProperty, "static", "Static lazy property can be reset through backing property")
    t.equal(count, 2, "Static lazy initializer is evaluated again after reset")
})
