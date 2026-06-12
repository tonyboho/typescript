import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    assertRenameAllowed,
    consumerSuperMixinMethodArgs,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    selfMixinPropertyArgs,
    selfMixinStaticPropertyArgs,
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
            { args : superMixinMethodArgs(sourceFile), description : "super mixin method call" },
            { args : consumerSuperMixinMethodArgs(sourceFile), description : "consumer super mixin method call" }
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

it("tsserver rename updates plain class members from instance and static usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const renamedPropertyText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseProperty")),
            sourceFile,
            "baseProperty",
            "renamedBaseProperty"
        )

        t.true(renamedPropertyText.includes("renamedBaseProperty: number"), "Renames plain property declaration")
        t.true(renamedPropertyText.includes("this.renamedBaseProperty"), "Renames plain property self usage")
        t.true(renamedPropertyText.includes("plain.renamedBaseProperty"), "Renames plain property external usage")

        const renamedMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseMethod")),
            sourceFile,
            "baseMethod",
            "renamedBaseMethod"
        )

        t.true(renamedMethodText.includes("renamedBaseMethod(): number"), "Renames plain method declaration")
        t.true(renamedMethodText.includes("plain.renamedBaseMethod()"), "Renames plain method external usage")

        const renamedStaticPropertyText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseStaticProperty")),
            sourceFile,
            "baseStaticProperty",
            "renamedBaseStaticProperty"
        )

        t.true(renamedStaticPropertyText.includes("renamedBaseStaticProperty: number"), "Renames plain static property declaration")
        t.true(renamedStaticPropertyText.includes("this.renamedBaseStaticProperty"), "Renames plain static property self usage")
        t.true(renamedStaticPropertyText.includes("PlainConsumer.renamedBaseStaticProperty"), "Renames plain static property external usage")

        const renamedStaticMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseStaticMethod")),
            sourceFile,
            "baseStaticMethod",
            "renamedBaseStaticMethod"
        )

        t.true(renamedStaticMethodText.includes("renamedBaseStaticMethod(): number"), "Renames plain static method declaration")
        t.true(renamedStaticMethodText.includes("PlainConsumer.renamedBaseStaticMethod()"), "Renames plain static method external usage")
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

it("tsserver rename updates mixin static members from self and external accesses", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinStaticPropertyArgs(sourceFile), description : "self mixin static property usage" },
            { args : usageArgs(sourceFile, "mixinStaticProperty"), description : "external mixin static property usage" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinStaticProperty",
                "renamedMixinStaticProperty"
            )

            t.true(renamedText.includes("renamedMixinStaticProperty: string"), `Renames static property declaration from ${scenario.description}`)
            t.true(renamedText.includes("this.renamedMixinStaticProperty"), `Renames static property self usage from ${scenario.description}`)
            t.true(renamedText.includes("MixinConsumer.renamedMixinStaticProperty"), `Renames static property external usage from ${scenario.description}`)
        }

        const renamedMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "mixinStaticMethod")),
            sourceFile,
            "mixinStaticMethod",
            "renamedMixinStaticMethod"
        )

        t.true(renamedMethodText.includes("renamedMixinStaticMethod(): string"), "Renames static method declaration")
        t.true(renamedMethodText.includes("MixinConsumer.renamedMixinStaticMethod()"), "Renames static method external usage")
    } finally {
        await dispose()
    }
})
