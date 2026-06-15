import { performance } from "node:perf_hooks"
import tsModule from "typescript"
import type * as ts from "typescript"
import { transformSourceFile } from "../src/index.js"
import {
    cloneSourceFileForTransform,
    preserveTopLevelStatementRanges,
    setParentRecursivePreservingVersion
} from "../src/util.js"
import type { TypeScript } from "../src/util.js"

// In-process microbenchmark for the source-view transform pipeline.
//
// The end-to-end suite (benchmark.suite.ts) drives real tsc / tsserver, where
// the transformer's own work is diluted by TypeScript bind + check and process
// startup -- a good regression guard, but a poor detector for a single pass
// inside the transformer. This benchmark isolates the four steps the compiler
// host runs per source-view file and reports how the time splits between them,
// so a candidate optimization (e.g. folding range preservation into expansion)
// can be judged before it is written.

const tsInstance = tsModule as unknown as TypeScript

type StepTimings = {
    clone     : number,
    transform : number,
    preserve  : number,
    setParent : number
}

const mixinCount   = integerEnv("TS_MIXIN_PASS_MIXINS", 80)
const propertyCount = integerEnv("TS_MIXIN_PASS_PROPS", 3)
const dependencyWindow = integerEnv("TS_MIXIN_PASS_WINDOW", 4)
const consumerCount = integerEnv("TS_MIXIN_PASS_CONSUMERS", 1)
const iterations   = integerEnv("TS_MIXIN_PASS_ITERATIONS", 400)
const warmups      = integerEnv("TS_MIXIN_PASS_WARMUPS", 80)

const fileName = "/virtual/transform-pass.ts"
const target   = tsModule.ScriptTarget.ES2022
const original = tsModule.createSourceFile(
    fileName,
    generateSource(mixinCount, propertyCount, dependencyWindow, consumerCount),
    target,
    true,
    tsModule.ScriptKind.TS
)

const warm: StepTimings = { clone : 0, transform : 0, preserve : 0, setParent : 0 }

for (let index = 0; index < warmups; index++) {
    runOnce(warm)
}

const totals: StepTimings = { clone : 0, transform : 0, preserve : 0, setParent : 0 }
const wallStart = performance.now()

for (let index = 0; index < iterations; index++) {
    runOnce(totals)
}

const wall = performance.now() - wallStart

printResults()

// One source-view transform, mirroring the source-view branch of the compiler
// host's getSourceFile, with each step timed separately.
function runOnce(into: StepTimings): void {
    let mark = performance.now()
    const cloned = cloneSourceFileForTransform(tsInstance, original, target)
    into.clone += performance.now() - mark

    mark = performance.now()
    const transformed = transformSourceFile(tsInstance, cloned, { sourceView : true })
    into.transform += performance.now() - mark

    if (transformed === cloned) {
        throw new Error("Generated file was not transformed -- mixin detection failed")
    }

    mark = performance.now()
    preserveTopLevelStatementRanges(tsInstance, transformed)
    into.preserve += performance.now() - mark

    mark = performance.now()
    setParentRecursivePreservingVersion(tsInstance, transformed, original)
    into.setParent += performance.now() - mark
}

function generateSource(mixins: number, properties: number, window: number, consumers: number): string {
    const lines = [ `import { mixin } from "ts-mixin-class"`, "" ]

    for (let index = 0; index < mixins; index++) {
        const dependencies: string[] = []

        for (let offset = 1; offset <= window && index - offset >= 0; offset++) {
            if ((index + offset) % 2 === 0) {
                dependencies.push(`Mixin${index - offset}`)
            }
        }

        const implementsClause = dependencies.length === 0 ? "" : ` implements ${dependencies.join(", ")}`

        lines.push(`@mixin()`)
        lines.push(`export class Mixin${index}${implementsClause} {`)

        for (let property = 0; property < properties; property++) {
            lines.push(`    value${index}_${property}: number = ${index * 1000 + property}`)
        }

        lines.push(`}`, "")
    }

    // Each consumer implements a window of leaf mixins shifted by its index, so
    // their dependency closures overlap heavily -- the realistic case where a
    // shared per-mixin linearization index would pay off across consumers.
    for (let consumer = 0; consumer < consumers; consumer++) {
        const leaves: string[] = []

        for (let index = mixins - 1 - consumer; index >= 0 && leaves.length < 8; index -= 2) {
            leaves.push(`Mixin${index}`)
        }

        lines.push(`export class Consumer${consumer} implements ${leaves.join(", ")} {`, `}`, "")
    }

    return lines.join("\n")
}

function printResults(): void {
    const sum = totals.clone + totals.transform + totals.preserve + totals.setParent

    console.log(`transform-pass benchmark`)
    console.log([
        `mixins=${mixinCount}`,
        `props=${propertyCount}`,
        `window=${dependencyWindow}`,
        `consumers=${consumerCount}`,
        `statements=${original.statements.length}`,
        `nodes=${countNodes(original)}`
    ].join(" "))
    console.log(`iterations=${iterations} warmups=${warmups}`)
    console.log("")
    console.log("step                    per-iter      share")
    reportStep("clone (reparse)", totals.clone, sum)
    reportStep("transform (dispatch)", totals.transform, sum)
    reportStep("preserveRanges (JS)", totals.preserve, sum)
    reportStep("setParentRecursive", totals.setParent, sum)
    console.log(`${"sum".padEnd(24)}${formatMs(sum / iterations).padStart(8)}`)
    console.log(`${"wall".padEnd(24)}${formatMs(wall / iterations).padStart(8)}`)
}

function reportStep(label: string, value: number, sum: number): void {
    console.log([
        label.padEnd(24),
        formatMs(value / iterations).padStart(8),
        `${((value / sum) * 100).toFixed(1)}%`.padStart(11)
    ].join(""))
}

function countNodes(node: ts.Node): number {
    let count = 1

    tsModule.forEachChild(node, (child) => {
        count += countNodes(child)
    })

    return count
}

function formatMs(value: number): string {
    return `${value.toFixed(4)}ms`
}

function integerEnv(name: string, fallback: number): number {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
