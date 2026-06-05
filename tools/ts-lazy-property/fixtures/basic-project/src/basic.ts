import { lazy } from "ts-lazy-property"


// class SourceClass {
//     @lazy
//     lazyProperty: Map<number, string> = new Map()
//     regularProperty: string = "ok"
// }

// const instance = new SourceClass()

// instance.lazyProperty.set(2, "ok")

// console.log(instance.$lazyProperty)
// console.log(instance.regularProperty)


class SourceClass2 {
    @lazy
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty() {
        return 'lazy_string_builder'
    }
}