import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

class Box<T> {
    constructor(readonly value: T) {
    }

    @lazy()
    values: T[] = [ this.value ]
}

function checkTypes(box: Box<string>): void {
    const values: string[] = box.values
    const backingValues: string[] | undefined = box.$values

    box.values = values
    box.$values = backingValues
    box.$values = undefined

    // @ts-expect-error Generic type is preserved.
    const numberValues: number[] = box.values
}

it("generic lazy property", async (t: Test) => {
    const box = new Box("ok")

    t.equal(box.$values, undefined, "Generic backing property is undefined before access")
    t.expect(box.values).toEqual([ "ok" ])
    t.expect(box.$values).toEqual([ "ok" ])
})
