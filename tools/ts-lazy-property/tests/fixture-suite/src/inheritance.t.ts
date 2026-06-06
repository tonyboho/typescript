import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

class BaseSource {
    @lazy()
    inheritedValue: string = "base"
}

class ChildSource extends BaseSource {
    readInheritedValue(): string {
        return this.inheritedValue
    }
}

function checkTypes(child: ChildSource): void {
    const inheritedValue: string = child.inheritedValue
    const inheritedBackingValue: string | undefined = child.$inheritedValue

    child.inheritedValue = inheritedValue
    child.$inheritedValue = inheritedBackingValue
    child.$inheritedValue = undefined

    // @ts-expect-error Inherited lazy property keeps the source type.
    const numberValue: number = child.inheritedValue
}

it("inherited lazy property", async (t: Test) => {
    const child = new ChildSource()

    t.equal(child.$inheritedValue, undefined, "Inherited backing property is undefined before access")
    t.equal(child.readInheritedValue(), "base", "Child can read inherited lazy property")
    t.equal(child.$inheritedValue, "base", "Inherited backing property is set after access")
})
