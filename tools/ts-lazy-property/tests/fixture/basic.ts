import { lazy } from "ts-lazy-property"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

let count = 0

class SourceClass {
    @lazy()
    lazyProperty1: string = "ok"

    @lazy()
    lazyProperty2: string = (() => {
        count++
        return "ok"
    })()
}

it("basic", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(instance.$lazyProperty1, undefined, "Property is undefined before it is accessed")

    instance.lazyProperty1

    t.equal(instance.$lazyProperty1, "ok", "Property is set to the value of the initializer")
})


it("lazy property can be reset", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(count, 0, "Lazy property is not initialized until it is accessed")

    instance.lazyProperty2

    t.equal(count, 1, "Lazy property is initialized when it is accessed")

    instance.lazyProperty2 = undefined

    instance.lazyProperty2

    t.equal(count, 2, "Lazy property is re-initialized after reset")
})
