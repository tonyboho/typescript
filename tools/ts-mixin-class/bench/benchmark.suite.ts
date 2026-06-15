import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
    createBenchmarkFixture,
    defaultCompileScenarios,
    scenarioDirectoryName,
    type BenchmarkScenario
} from "./fixture-generator.js"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated")
const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type BenchmarkResult = {
    scenario   : BenchmarkScenario,
    durations : number[]
}

const iterations = integerEnv("TS_MIXIN_BENCH_ITERATIONS", 3)
const warmups = integerEnv("TS_MIXIN_BENCH_WARMUPS", 1)
const scenarios = compileScenarios()
const results: BenchmarkResult[] = []

console.log(`ts-mixin-class benchmark suite`)
console.log(`iterations=${iterations} warmups=${warmups}`)
console.log("")

for (const scenario of scenarios) {
    const fixture = await createBenchmarkFixture({
        packageRoot,
        root : generatedRoot,
        scenario
    })

    console.log(`compile ${scenarioDirectoryName(scenario)}`)

    for (let index = 0; index < warmups; index++) {
        await runCleanCompile(fixture.tsconfigFile, fixture.directory)
    }

    const durations: number[] = []

    for (let index = 0; index < iterations; index++) {
        durations.push(await runCleanCompile(fixture.tsconfigFile, fixture.directory))
    }

    results.push({ scenario, durations })
}

console.log("")
console.log("Compile benchmark")
console.log("scenario                              min       median    mean")

for (const result of results) {
    const stats = durationStats(result.durations)

    console.log([
        scenarioDirectoryName(result.scenario).padEnd(36),
        formatDuration(stats.min).padStart(8),
        formatDuration(stats.median).padStart(9),
        formatDuration(stats.mean).padStart(8)
    ].join(" "))
}

async function runCleanCompile(tsconfigFile: string, directory: string): Promise<number> {
    await rm(path.join(directory, "dist"), { force : true, recursive : true })

    const start = performance.now()

    await execFileAsync(process.execPath, [ tscFile, "-p", tsconfigFile ], {
        cwd       : directory,
        maxBuffer : 10 * 1024 * 1024
    })

    return performance.now() - start
}

function compileScenarios(): BenchmarkScenario[] {
    const sizes = process.env.TS_MIXIN_BENCH_SIZES

    if (sizes === undefined) {
        return defaultCompileScenarios()
    }

    return sizes.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
        .map((size) => {
            return {
                name              : `binary-tree-${size}-public-properties`,
                size,
                graph             : "binary-tree",
                members           : "public-properties",
                consumerLeafCount : Math.min(8, Math.max(1, Math.ceil(size / 32)))
            }
        })
}

function integerEnv(name: string, fallback: number): number {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function durationStats(values: number[]): { min: number, median: number, mean: number } {
    const sorted = [ ...values ].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length

    return {
        min : sorted[0]!,
        median,
        mean
    }
}

function formatDuration(value: number): string {
    return `${value.toFixed(1)}ms`
}
