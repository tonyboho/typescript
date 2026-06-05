import { lazy } from "ts-lazy-property"


class SourceClass {
    @lazy
    lazyProperty: Map<number, string> = new Map()
}

const instance = new SourceClass()

console.log(instance.$lazyProperty)

instance.lazyProperty.set(2, "ok")

console.log(instance.$lazyProperty)


class SourceClass2 {
    @lazy
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty() {
        return 'lazy_string_builder'
    }
}