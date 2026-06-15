import { execFile, fork } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
    binaryTreePublicPropertiesScenario,
    createBenchmarkFixture,
    defaultEditScenarios,
    defaultCompileScenarios,
    defaultTsServerScenarios,
    scenarioDirectoryName,
    type BenchmarkFixture,
    type BenchmarkScenario
} from "./fixture-generator.js"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated")
const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")
const tsserverFile = path.join(packageRoot, "node_modules", "typescript", "lib", "tsserver.js")

type BenchmarkMode = "all" | "compile" | "edit" | "tsserver"

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

type TsServerSession = {
    close       : () => Promise<void>,
    sendRequest : (command: string, args: unknown) => Promise<TsServerResponse>
}

const mode = benchmarkMode()
const iterations = integerEnv("TS_MIXIN_BENCH_ITERATIONS", 3)
const warmups = integerEnv("TS_MIXIN_BENCH_WARMUPS", 1)
const propertyCount = integerEnv("TS_MIXIN_BENCH_PROPERTY_COUNT", 1)
const editCount = integerEnv("TS_MIXIN_BENCH_EDIT_COUNT", 8)

console.log(`ts-mixin-class benchmark suite`)
console.log(`mode=${mode}`)
console.log(`iterations=${iterations} warmups=${warmups} propertyCount=${propertyCount}`)
console.log("")

if (mode === "all" || mode === "compile") {
    await runCompileBenchmark()
}

if (mode === "all" || mode === "tsserver") {
    await runTsServerBenchmark()
}

if (mode === "all" || mode === "edit") {
    await runEditBenchmark()
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

async function runEditBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of editScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "edit"),
            scenario
        })

        console.log(`edit ${scenarioDirectoryName(scenario)} files=${editCount}`)

        for (let index = 0; index < warmups; index++) {
            await runEditProcessingRequests(fixture, editCount)
        }

        const durations: number[] = []

        for (let index = 0; index < iterations; index++) {
            durations.push(...await runEditProcessingRequests(fixture, editCount))
        }

        results.push({ scenario, durations })
    }

    printResults("Tsserver edit processing benchmark", results)
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
    const session = createTsServerSession(fixtureDirectory)

    try {
        await openFile(session, consumerFile, text)

        const start = performance.now()
        const response = await session.sendRequest("semanticDiagnosticsSync", { file : consumerFile })
        const duration = performance.now() - start

        assertSuccessfulTsServerResponse(response, "semanticDiagnosticsSync")

        return duration
    } finally {
        await session.close()
    }
}

async function runEditProcessingRequests(
    fixture: BenchmarkFixture,
    requestedEditCount: number
): Promise<number[]> {
    const session = createTsServerSession(fixture.directory)
    const editFiles = fixture.mixinFiles.slice(-Math.min(requestedEditCount, fixture.mixinFiles.length))
    const textByFile = new Map<string, string>()

    try {
        const consumerText = await readFile(fixture.consumerFile, "utf8")

        await openFile(session, fixture.consumerFile, consumerText)

        for (const fileName of editFiles) {
            const text = await readFile(fileName, "utf8")

            textByFile.set(fileName, text)
            await openFile(session, fileName, text)
        }

        assertSuccessfulTsServerResponse(
            await session.sendRequest("semanticDiagnosticsSync", { file : fixture.consumerFile }),
            "semanticDiagnosticsSync"
        )

        const durations: number[] = []

        for (let editIndex = 0; editIndex < requestedEditCount; editIndex++) {
            const fileName = editFiles[editIndex % editFiles.length]!
            const currentText = textByFile.get(fileName)!
            const edit = createMixinPropertyInitializerEdit(currentText, editIndex)
            const start = performance.now()

            assertSuccessfulTsServerResponse(
                await session.sendRequest("change", {
                    file      : fileName,
                    line      : edit.line,
                    offset    : edit.offset,
                    endLine   : edit.endLine,
                    endOffset : edit.endOffset,
                    insertString : edit.insertString
                }),
                "change"
            )
            assertSuccessfulTsServerResponse(
                await session.sendRequest("semanticDiagnosticsSync", { file : fixture.consumerFile }),
                "semanticDiagnosticsSync"
            )

            durations.push(performance.now() - start)
            textByFile.set(fileName, edit.nextText)
        }

        return durations
    } finally {
        await session.close()
    }
}

function createTsServerSession(fixtureDirectory: string): TsServerSession {
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

    return {
        close       : stopServer,
        sendRequest
    }

    function sendRequest(command: string, args: unknown): Promise<TsServerResponse> {
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
        return defaultCompileScenarios(propertyCount)
    }

    return sizes.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
        .map((size) => {
            return binaryTreePublicPropertiesScenario(size, propertyCount)
        })
}

function tsServerScenarios(): BenchmarkScenario[] {
    const sizes = process.env.TS_MIXIN_BENCH_TSSERVER_SIZES

    if (sizes === undefined) {
        return defaultTsServerScenarios(propertyCount)
    }

    return sizes.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
        .map((size) => {
            return binaryTreePublicPropertiesScenario(size, propertyCount)
        })
}

function editScenarios(): BenchmarkScenario[] {
    const sizes = process.env.TS_MIXIN_BENCH_EDIT_SIZES

    if (sizes === undefined) {
        return defaultEditScenarios(propertyCount)
    }

    return sizes.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
        .map((size) => {
            return binaryTreePublicPropertiesScenario(size, propertyCount)
        })
}

function benchmarkMode(): BenchmarkMode {
    const modeArgument = process.argv[2] ?? "all"

    if (modeArgument === "all" || modeArgument === "compile" || modeArgument === "edit" || modeArgument === "tsserver") {
        return modeArgument
    }

    throw new Error(`Unknown benchmark mode ${JSON.stringify(modeArgument)}. Use all, compile, edit, or tsserver.`)
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

async function openFile(session: TsServerSession, fileName: string, text: string): Promise<void> {
    assertSuccessfulTsServerResponse(
        await session.sendRequest("open", {
            file            : fileName,
            fileContent     : text,
            projectRootPath : path.dirname(path.dirname(fileName)),
            scriptKindName  : "TS"
        }),
        "open"
    )
}

function assertSuccessfulTsServerResponse(response: TsServerResponse, command: string): void {
    if (response.success !== true) {
        throw new Error(response.message ?? `tsserver ${command} failed`)
    }
}

function createMixinPropertyInitializerEdit(
    text: string,
    editIndex: number
): {
    endLine      : number,
    endOffset    : number,
    insertString : string,
    line         : number,
    nextText     : string,
    offset       : number
} {
    const match = /value\d+_0: number = \d+/.exec(text)

    if (match === null) {
        throw new Error("Cannot find benchmark property initializer to edit")
    }

    const prefix = match[0].replace(/\d+$/, "")
    const start = match.index + prefix.length
    const end = match.index + match[0].length
    const insertString = String(10_000_000 + editIndex)
    const startPosition = positionToLineOffset(text, start)
    const endPosition = positionToLineOffset(text, end)

    return {
        ...startPosition,
        endLine   : endPosition.line,
        endOffset : endPosition.offset,
        insertString,
        nextText  : text.slice(0, start) + insertString + text.slice(end)
    }
}

function positionToLineOffset(text: string, position: number): { line: number, offset: number } {
    const before = text.slice(0, position)
    const lines = before.split("\n")

    return {
        line   : lines.length,
        offset : lines.at(-1)!.length + 1
    }
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
