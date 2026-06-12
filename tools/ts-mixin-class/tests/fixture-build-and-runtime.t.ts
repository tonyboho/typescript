import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, commandOutput, createTypeScriptFixture, packageRoot, runCommand, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

it("builds and runs the fixture suite with standard decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "clean:standard"),
        "Clean fixture suite standard build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:standard"),
        "Build fixture suite with standard decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:standard"),
        "Run fixture suite with standard decorators"
    )
})

it("builds and runs the fixture suite with legacy decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "clean:legacy"),
        "Clean fixture suite legacy build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:legacy"),
        "Build fixture suite with legacy decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:legacy"),
        "Run fixture suite with legacy decorators"
    )
})

it("rejects bad consumer generic and override contracts in generated output", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "mixins.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class SourceClass1<A1> {
                        passThrough1(a: A1): A1 {
                            return a
                        }
                    }

                    @mixin()
                    export class SourceClass2<A2> {
                        method2(): A2 {
                            throw new Error("not implemented")
                        }
                    }
                `
            },
            {
                fileName : "bad-consumer-contract.ts",
                text     : `
                    import { SourceClass1, SourceClass2 } from "./mixins.js"

                    class BadGenericConsumer implements SourceClass1<string> {
                        passThrough1(a: number): number {
                            return a
                        }
                    }

                    class BadOverrideConsumer implements SourceClass2<boolean> {
                        method2(): number {
                            return 1
                        }
                    }

                    void [ BadGenericConsumer, BadOverrideConsumer ]
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const output = commandOutput(result)

        t.true(result.exitCode !== 0, "Negative consumer contract fixture fails to build")
        t.true(output.includes("passThrough1"), output)
        t.true(output.includes("method2"), output)
    } finally {
        await fixture.dispose()
    }
})

it("rejects inconsistent diamond requirements during transform", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "bad-linearization.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    class A {
                        a(): string {
                            return "A"
                        }
                    }

                    @mixin()
                    class B {
                        b(): string {
                            return "B"
                        }
                    }

                    @mixin()
                    class X implements A, B {
                    }

                    @mixin()
                    class Y implements B, A {
                    }

                    @mixin()
                    class Z implements X, Y {
                    }

                    class BadDiamondConsumer implements Z {
                    }

                    void BadDiamondConsumer
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const output = commandOutput(result)

        t.true(result.exitCode !== 0, "Negative linearization fixture fails to build")
        t.true(output.includes("Cannot linearize mixin classes"), output)
    } finally {
        await fixture.dispose()
    }
})

it("reports imported declaration mixins without runtime values", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles            : [
            {
                fileName : "node_modules/broken-mixin-package/package.json",
                text     : JSON.stringify({
                    name    : "broken-mixin-package",
                    type    : "module",
                    exports : {
                        "." : {
                            types : "./index.d.ts"
                        }
                    }
                }, null, 4)
            }
        ],
        sourceFiles            : [
            {
                fileName : "node_modules/broken-mixin-package/index.d.ts",
                text     : `
                    import type { RuntimeMixinClass } from "ts-mixin-class"

                    export interface BrokenMixin {
                        brokenMethod(): string
                    }

                    export declare const BrokenMixin: RuntimeMixinClass & {
                        new (...args: any[]): BrokenMixin
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import type { BrokenMixin } from "broken-mixin-package"

                    class Consumer implements BrokenMixin {
                    }

                    void Consumer
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const output = commandOutput(result)

        t.true(result.exitCode !== 0, "Broken declaration-only mixin package fails to build")
        t.true(output.includes("Missing mixin runtime value"), output)
        t.true(output.includes("BrokenMixin"), output)
        t.true(output.includes("broken-mixin-package"), output)
    } finally {
        await fixture.dispose()
    }
})
