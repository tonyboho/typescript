import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    public publicProperty: string = "public"

    @lazy()
    protected protectedProperty: string = "protected"

    @lazy()
    private privateProperty: string = "private"

    readAll(): string {
        return [
            this.publicProperty,
            this.protectedProperty,
            this.privateProperty
        ].join("-")
    }

    readBackingBeforeAccess(): string {
        return [
            this.$publicProperty ?? "",
            this.$protectedProperty ?? "",
            this.$privateProperty ?? ""
        ].join("-")
    }
}

class ChildSource extends SourceClass {
    readInheritedBeforeAccess(): string {
        return `${this.$protectedProperty ?? ""}`
    }

    readInherited(): string {
        return `${this.protectedProperty}-${this.$protectedProperty ?? ""}`
    }
}

function readPublicBackingFromOutside(instance: SourceClass): string {
    return instance.$publicProperty ?? ""
}

function readPublicLazyFromOutside(instance: SourceClass): string {
    return instance.publicProperty
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkTypes(instance: SourceClass, child: ChildSource): void {
    instance.publicProperty = "ok"
    instance.$publicProperty = "ok"

    // @ts-expect-error Protected lazy property is not accessible outside the class hierarchy.
    instance.protectedProperty

    // @ts-expect-error Protected backing property is not accessible outside the class hierarchy.
    instance.$protectedProperty

    // @ts-expect-error Protected lazy property is not accessible from external code even on a subclass instance.
    child.protectedProperty

    // @ts-expect-error Protected backing property is not accessible from external code even on a subclass instance.
    child.$protectedProperty

    // @ts-expect-error Private lazy property is not accessible outside the declaring class.
    instance.privateProperty

    // @ts-expect-error Private backing property is not accessible outside the declaring class.
    instance.$privateProperty

    // @ts-expect-error Private lazy property is not accessible from a subclass.
    child.privateProperty

    // @ts-expect-error Private backing property is not accessible from a subclass.
    child.$privateProperty
}

it("access modifiers", async (t: Test) => {
    const instance       = new SourceClass()
    const child          = new ChildSource()
    const publicInstance = new SourceClass()

    t.equal(instance.readBackingBeforeAccess(), "--", "Reads backing properties inside the declaring class before access")
    t.equal(instance.readAll(), "public-protected-private", "Reads lazy properties inside the declaring class")
    t.equal(child.readInheritedBeforeAccess(), "", "Subclass can read inherited protected backing property before access")
    t.equal(child.readInherited(), "protected-protected", "Subclass can read inherited protected lazy property")
    t.equal(readPublicBackingFromOutside(publicInstance), "", "Public backing property is readable from outside before access")
    t.equal(readPublicLazyFromOutside(publicInstance), "public", "Public lazy property is readable from outside")
    t.equal(readPublicBackingFromOutside(publicInstance), "public", "Public backing property is set after lazy access")
})
