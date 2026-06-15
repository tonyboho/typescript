import { performance } from "node:perf_hooks"
import tsModule from "typescript"
import type * as ts from "typescript"
import { printSourceFile, transformSourceFile } from "../src/index.js"
import {
    cloneSourceFileForTransform,
    preserveTopLevelStatementRanges,
    setParentRecursivePreservingVersion
} from "../src/util.js"
import type { TypeScript } from "../src/util.js"

// In-process microbenchmark for the per-file transform pipeline.
//
// The end-to-end suite (benchmark.suite.ts) drives real tsc / tsserver, where
// the transformer's own work is diluted by TypeScript bind + check and process
// startup -- a good regression guard, but a poor detector for a single pass
// inside the transformer. This benchmark isolates the steps the compiler host
// runs per file and reports how the time splits between them, so a candidate
// optimization can be judged (and CPU-profiled) before it is written.
//
// TS_MIXIN_PASS_MODE selects the pipeline:
//   source-view (default): clone -> transform -> preserve ranges -> setParent
//   emit:                  transform -> print -> reparse

const tsInstance = tsModule as unknown as TypeScript

type StepTimings = Map<string, number>

const mode         = stringEnv("TS_MIXIN_PASS_MODE", "source-view")
const mixinCount   = integerEnv("TS_MIXIN_PASS_MIXINS", 80)
const propertyCount = integerEnv("TS_MIXIN_PASS_PROPS", 3)
const dependencyWindow = integerEnv("TS_MIXIN_PASS_WINDOW", 4)
const consumerCount = integerEnv("TS_MIXIN_PASS_CONSUMERS", 1)
const iterations   = integerEnv("TS_MIXIN_PASS_ITERATIONS", 400)
const warmups      = integerEnv("TS_MIXIN_PASS_WARMUPS", 80)

if (mode !== "source-view" && mode !== "emit") {
    throw new Error(`Unknown TS_MIXIN_PASS_MODE ${JSON.stringify(mode)}; use "source-view" or "emit".`)
}

const fileName = "/virtual/transform-pass.ts"
const target   = tsModule.ScriptTarget.ES2022
const original = tsModule.createSourceFile(
    fileName,
    generateSource(mixinCount, propertyCount, dependencyWindow, consumerCount),
    target,
    true,
    tsModule.ScriptKind.TS
)

for (let index = 0; index < warmups; index++) {
    runOnce(new Map())
}

const totals: StepTimings = new Map()
const wallStart = performance.now()

for (let index = 0; index < iterations; index++) {
    runOnce(totals)
}

const wall = performance.now() - wallStart

printResults()

function runOnce(into: StepTimings): void {
    if (mode === "emit") {
        runEmitOnce(into)
    } else {
        runSourceViewOnce(into)
    }
}

// Mirrors the source-view branch of the compiler host's getSourceFile.
function runSourceViewOnce(into: StepTimings): void {
    const cloned = time(into, "clone (reparse)", () => cloneSourceFileForTransform(tsInstance, original, target))
    const transformed = time(into, "transform (dispatch)", () => transformSourceFile(tsInstance, cloned, { sourceView : true }))

    if (transformed === cloned) {
        throw new Error("Generated file was not transformed -- mixin detection failed")
    }

    time(into, "preserveRanges (JS)", () => preserveTopLevelStatementRanges(tsInstance, transformed))
    time(into, "setParentRecursive", () => setParentRecursivePreservingVersion(tsInstance, transformed, original))
}

// Mirrors the emit branch of getSourceFile: transform, print, reparse.
function runEmitOnce(into: StepTimings): void {
    const transformed = time(into, "transform (dispatch)", () => transformSourceFile(tsInstance, original, { sourceView : false }))

    if (transformed === original) {
        throw new Error("Generated file was not transformed -- mixin detection failed")
    }

    const text = time(into, "print", () => printSourceFile(tsInstance, transformed))

    time(into, "reparse", () => tsModule.createSourceFile(fileName, text, target, true, tsModule.ScriptKind.TS))
}

function time<T>(into: StepTimings, key: string, run: () => T): T {
    const mark = performance.now()
    const result = run()

    into.set(key, (into.get(key) ?? 0) + (performance.now() - mark))

    return result
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
    const sum = [ ...totals.values() ].reduce((accumulator, value) => accumulator + value, 0)

    console.log(`transform-pass benchmark`)
    console.log([
        `mode=${mode}`,
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

    for (const [ label, value ] of totals) {
        reportStep(label, value, sum)
    }

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

function stringEnv(name: string, fallback: string): string {
    return process.env[name] ?? fallback
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
