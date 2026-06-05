import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: Map<number, string> = 123

    regularProperty: string = "ok"
}

const instance = new SourceClass()

instance.lazyProperty.set(2, "ok")

console.log(instance.$lazyProperty)
console.log(instance.regularProperty)
