import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: Map<numbhjkgkgexr, string> = new Map()

    regularProperty: string = "ok"
}

const instance = new SourceClass()

instance.lazyProperty.set(2, "ok")

console.log(instance.$lazyProperty)
console.log(instance.regularProperty)
