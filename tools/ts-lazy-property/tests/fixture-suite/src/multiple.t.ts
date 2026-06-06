import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    firstValue: string = "first"

    @lazy()
    secondValue: number = 2

    @lazy()
    thirdValue: boolean = true
}

function checkTypes(instance: SourceClass): void {
    const firstValue: string = instance.firstValue
    const secondValue: number = instance.secondValue
    const thirdValue: boolean = instance.thirdValue

    const firstBackingValue: string | undefined = instance.$firstValue
    const secondBackingValue: number | undefined = instance.$secondValue
    const thirdBackingValue: boolean | undefined = instance.$thirdValue

    instance.firstValue = firstValue
    instance.secondValue = secondValue
    instance.thirdValue = thirdValue

    instance.$firstValue = firstBackingValue
    instance.$secondValue = secondBackingValue
    instance.$thirdValue = thirdBackingValue
}

it("multiple lazy properties", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(instance.$firstValue, undefined, "First backing property is undefined before access")
    t.equal(instance.$secondValue, undefined, "Second backing property is undefined before access")
    t.equal(instance.$thirdValue, undefined, "Third backing property is undefined before access")

    t.equal(instance.firstValue, "first", "Reads first lazy property")
    t.equal(instance.secondValue, 2, "Reads second lazy property")
    t.equal(instance.thirdValue, true, "Reads third lazy property")

    t.equal(instance.$firstValue, "first", "First backing property is set after access")
    t.equal(instance.$secondValue, 2, "Second backing property is set after access")
    t.equal(instance.$thirdValue, true, "Third backing property is set after access")
})
