import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, packageRoot, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "declaration-fixture-suite")
const libraryFixtureDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

it("builds and runs the declaration fixture suite", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install declaration fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(libraryFixtureDirectory, "run", "clean:standard"),
        "Clean fixture suite library package standard build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(libraryFixtureDirectory, "run", "build:standard"),
        "Build fixture suite library package"
    )

    const mixinsDeclaration = await readFile(
        path.join(libraryFixtureDirectory, "dist", "standard", "mixins.d.ts"),
        "utf8"
    )
    const defaultMixinDeclaration = await readFile(
        path.join(libraryFixtureDirectory, "dist", "standard", "default-mixin.d.ts"),
        "utf8"
    )

    t.true(mixinsDeclaration.includes("export declare const __SourceClass1$mixin"), "Named mixin factory is exported for downstream generated imports")
    t.true(mixinsDeclaration.includes("export declare const SourceClass1"), "Named mixin runtime value is exported")
    t.true(defaultMixinDeclaration.includes("export declare const __DefaultMixin$mixin"), "Default mixin factory is exported for downstream generated imports")
    t.true(defaultMixinDeclaration.includes("declare const DefaultMixin"), "Default mixin runtime value is declared")
    t.true(defaultMixinDeclaration.includes("export default DefaultMixin"), "Default mixin declaration preserves default export shape")
    t.false(defaultMixinDeclaration.includes("export declare const DefaultMixin"), "Default mixin value is not accidentally exported as a named value")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build"),
        "Build declaration fixture consumer"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test"),
        "Run declaration fixture consumer"
    )
})
