import { it, type Test } from "@bryntum/siesta/nodejs.js"

import * as LazyProperty from "ts-lazy-property"
import { lazy as lazyProperty } from "ts-lazy-property"

function lazy(..._args: unknown[]): void {
}

class SourceClass {
    @lazyProperty()
    lazyProperty1: Map<number, string> = new Map()

    @LazyProperty.lazy()
    lazyProperty2: Set<string> = new Set()

    @lazy
    regularProperty: string = "ok"
}

it("basic import", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(instance.$lazyProperty1, undefined, "Lazy property 1 is undefined before it is accessed")
    t.equal(instance.$lazyProperty2, undefined, "Lazy property 2 is undefined before it is accessed")

    t.equal(instance.regularProperty, "ok", "Regular property is set to the value of the initializer")

    instance.lazyProperty1

    t.equal(instance.$lazyProperty1, new Map(), "Lazy property 1 is set to the value of the initializer")

    instance.lazyProperty2

    t.equal(instance.$lazyProperty2, new Set(), "Lazy property 2 is set to the value of the initializer")
})