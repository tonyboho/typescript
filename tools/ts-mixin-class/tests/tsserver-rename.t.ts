import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    assertRenameAllowed,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    superMixinMethodArgs,
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
