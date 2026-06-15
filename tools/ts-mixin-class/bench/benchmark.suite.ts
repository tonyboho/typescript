import { execFile, fork } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
    createBenchmarkFixture,
    defaultCompileScenarios,
    defaultTsServerScenarios,
    scenarioDirectoryName,
    type BenchmarkScenario
} from "./fixture-generator.js"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated")
const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")
const tsserverFile = path.join(packageRoot, "node_modules", "typescript", "lib", "tsserver.js")

type BenchmarkMode = "all" | "compile" | "tsserver"

type BenchmarkResult = {
    scenario   : BenchmarkScenario,
    durations : number[]
}

type TsServerResponse = {
    body?       : unknown,
    command?    : string,
    message?    : string,
    request_seq?: number,
    success?    : boolean,
    type?       : string
}

const mode = benchmarkMode()
const iterations = integerEnv("TS_MIXIN_BENCH_ITERATIONS", 3)
const warmups = integerEnv("TS_MIXIN_BENCH_WARMUPS", 1)

console.log(`ts-mixin-class benchmark suite`)
console.log(`mode=${mode}`)
console.log(`iterations=${iterations} warmups=${warmups}`)
console.log("")

if (mode === "all" || mode === "compile") {
    await runCompileBenchmark()
}

if (mode === "all" || mode === "tsserver") {
    await runTsServerBenchmark()
}

async function runCompileBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of compileScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "compile"),
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

    printResults("Compile benchmark", results)
}

async function runTsServerBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of tsServerScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "tsserver"),
            scenario
        })

        console.log(`tsserver ${scenarioDirectoryName(scenario)}`)

        for (let index = 0; index < warmups; index++) {
            await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile)
        }

        const durations: number[] = []

        for (let index = 0; index < iterations; index++) {
            durations.push(await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile))
        }

        results.push({ scenario, durations })
    }

    printResults("Tsserver semantic diagnostics benchmark", results)
}

async function runCleanCompile(tsconfigFile: string, directory: string): Promise<number> {
    await rm(path.join(directory, "dist"), { force : true, recursive : true })

    const start = performance.now()

    try {
        await execFileAsync(process.execPath, [ tscFile, "-p", tsconfigFile ], {
            cwd       : directory,
            maxBuffer : 10 * 1024 * 1024
        })
    } catch (error) {
        throw commandError("tsc", error)
    }

    return performance.now() - start
}

async function runSemanticDiagnosticsRequest(
    fixtureDirectory: string,
    consumerFile: string
): Promise<number> {
    const text = await readFile(consumerFile, "utf8")
    const server = fork(tsserverFile, [
        "--logVerbosity",
        "terse",
        "--logFile",
        path.join(fixtureDirectory, "tsserver.log"),
        "--allowLocalPluginLoads",
        "--useNodeIpc"
    ], {
        cwd    : fixtureDirectory,
        silent : true
    })
    const pendingResponses = new Map<number, (response: TsServerResponse) => void>()
    let sequence = 0

    server.on("message", (message: TsServerResponse) => {
        if (message.type !== "response" || message.request_seq === undefined) {
            return
        }

        pendingResponses.get(message.request_seq)?.(message)
        pendingResponses.delete(message.request_seq)
    })
    server.stdout?.on("data", () => {})
    server.stderr?.on("data", () => {})

    try {
        await sendRequest("open", {
            file            : consumerFile,
            fileContent     : text,
            projectRootPath : fixtureDirectory,
            scriptKindName  : "TS"
        })

        const start = performance.now()
        const response = await sendRequest("semanticDiagnosticsSync", { file : consumerFile })
        const duration = performance.now() - start

        if (response.success !== true) {
            throw new Error(response.message ?? "tsserver semanticDiagnosticsSync failed")
        }

        return duration
    } finally {
        await stopServer()
    }

    async function sendRequest(command: string, args: unknown): Promise<TsServerResponse> {
        const seq = ++sequence

        server.send({
            arguments : args,
            command,
            seq,
            type      : "request"
        })

        return new Promise<TsServerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingResponses.delete(seq)
                reject(new Error(`Timed out waiting for tsserver response to ${command}.`))
            }, 30_000)

            pendingResponses.set(seq, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })
        })
    }

    async function stopServer(): Promise<void> {
        if (!server.connected) {
            return
        }

        server.send({
            arguments : {},
            command   : "exit",
            seq       : ++sequence,
            type      : "request"
        })

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                server.kill()
                reject(new Error("Timed out waiting for tsserver to exit."))
            }, 10_000)

            server.once("exit", () => {
                clearTimeout(timeout)
                resolve()
            })
            server.once("error", (error) => {
                clearTimeout(timeout)
                reject(error)
            })
        })
    }
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

function tsServerScenarios(): BenchmarkScenario[] {
    const sizes = process.env.TS_MIXIN_BENCH_TSSERVER_SIZES

    if (sizes === undefined) {
        return defaultTsServerScenarios()
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

function benchmarkMode(): BenchmarkMode {
    const modeArgument = process.argv[2] ?? "all"

    if (modeArgument === "all" || modeArgument === "compile" || modeArgument === "tsserver") {
        return modeArgument
    }

    throw new Error(`Unknown benchmark mode ${JSON.stringify(modeArgument)}. Use all, compile, or tsserver.`)
}

function integerEnv(name: string, fallback: number): number {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function printResults(title: string, results: BenchmarkResult[]): void {
    console.log("")
    console.log(title)
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

function commandError(command: string, error: unknown): Error {
    const failure = error as { message?: string, stdout?: string | Buffer, stderr?: string | Buffer }
    const stdout = outputToString(failure.stdout)
    const stderr = outputToString(failure.stderr)

    return new Error([
        `${command} failed`,
        stdout === "" ? undefined : `stdout:\n${stdout}`,
        stderr === "" ? undefined : `stderr:\n${stderr}`,
        failure.message
    ].filter((part) => part !== undefined && part !== "").join("\n\n"))
}

function outputToString(output: string | Buffer | undefined): string {
    return Buffer.isBuffer(output) ? output.toString("utf8") : output ?? ""
}
