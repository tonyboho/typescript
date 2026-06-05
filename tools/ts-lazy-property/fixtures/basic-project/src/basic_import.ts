import * as LazyProperty from "ts-lazy-property"
import { lazy as lazyProperty } from "ts-lazy-property"

function lazy(..._args: unknown[]): void {
}

class SourceClass {
    @lazyProperty
    lazyProperty: Map<number, string> = new Map()

    @LazyProperty.lazy
    namespaceProperty: Set<string> = new Set()

    method(): Map<number, string> {
        if (this.$lazyProperty !== undefined) {
            this.$lazyProperty.set(1, "ready")
        }

        if (this.$namespaceProperty !== undefined) {
            this.$namespaceProperty.add("ready")
        }

        return this.lazyProperty
    }
}

class LocalDecoratorClass {
    @lazy
    regularProperty: string = "ok"

    method(): string {
        return this.regularProperty
    }
}

const instance = new SourceClass()

instance.lazyProperty.set(2, "ok")
instance.$lazyProperty?.set(3, "visible")
instance.namespaceProperty.add("ok")
instance.$namespaceProperty?.add("visible")
new LocalDecoratorClass().method()
