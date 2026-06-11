import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

@mixin()
class SourceClass {
    value: string = "ok"

    getValue(): string {
        return this.value
    }
}

it("basic", async (t: Test) => {
    const instance = new SourceClass()

    t.equal(instance.getValue(), "ok", "Class decorated with @mixin() compiles and runs")
})
