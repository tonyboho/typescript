import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    assertRenameAllowed,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    selfMixinPropertyArgs,
    superMixinMethodArgs,
    superMixinPropertyArgs,
    usageArgs
} from "./tsserver-editor-util.js"

it("tsserver rename updates mixin method usages from self, external and super calls", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinMethodArgs(sourceFile), description : "self mixin method call" },
            { args : usageArgs(sourceFile, "mixinMethod"), description : "external mixin method call" },
            { args : superMixinMethodArgs(sourceFile), description : "super mixin method call" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinMethod",
                "renamedMixinMethod"
            )

            t.true(renamedText.includes("renamedMixinMethod(): string"), `Renames declaration from ${scenario.description}`)
            t.true(renamedText.includes("this.renamedMixinMethod()"), `Renames self usage from ${scenario.description}`)
            t.true(renamedText.includes("mixed.renamedMixinMethod()"), `Renames external usage from ${scenario.description}`)
            t.true(renamedText.includes("super.renamedMixinMethod()"), `Renames super usage from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver rename updates mixin property usages from self, external and super accesses", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinPropertyArgs(sourceFile), description : "self mixin property usage" },
            { args : usageArgs(sourceFile, "mixinProperty"), description : "external mixin property usage" },
            { args : superMixinPropertyArgs(sourceFile), description : "super mixin property usage" },
            { args : consumerSuperMixinPropertyArgs(sourceFile), description : "consumer super mixin property usage" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinProperty",
                "renamedMixinProperty"
            )

            t.true(renamedText.includes("renamedMixinProperty: string"), `Renames declaration from ${scenario.description}`)
            t.true(renamedText.includes("this.renamedMixinProperty"), `Renames self usage from ${scenario.description}`)
            t.true(renamedText.includes("mixed.renamedMixinProperty"), `Renames external usage from ${scenario.description}`)
            t.true(renamedText.includes("super.renamedMixinProperty"), `Renames super usage from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})
