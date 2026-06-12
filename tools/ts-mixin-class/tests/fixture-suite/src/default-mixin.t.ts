import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import DefaultMixin from "./default-mixin.js"

class DefaultConsumer implements DefaultMixin {
    own(): string {
        return super.defaultMethod()
    }
}

const consumer = new DefaultConsumer()

const v1: string = consumer.defaultValue
const v2: string = consumer.defaultMethod()
const v3: string = consumer.own()
const v4: string = DefaultConsumer.staticDefault()

it("uses a default-exported mixin", async (t: Test) => {
    t.equal(consumer.defaultValue, "default", "Default mixin field is applied")
    t.equal(consumer.defaultMethod(), "default", "Default mixin method is applied")
    t.equal(consumer.own(), "default", "Consumer super reaches the default mixin")
    t.equal(DefaultConsumer.staticDefault(), "staticDefault", "Default mixin statics are copied")
    t.true(consumer instanceof DefaultMixin, "Default-imported mixin instanceof works")
})

void [ v1, v2, v3, v4 ]
