import { execFile, fork } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import tsModule from "typescript"
import type * as ts from "typescript"
import { transformSourceFile } from "../src/index.js"
import {
    cloneSourceFileForTransform,
    preserveTopLevelStatementRanges,
    setParentRecursivePreservingVersion
} from "../src/util.js"
import type { TypeScript } from "../src/util.js"
import {
    createBenchmarkFixture,
    defaultEditScenarios,
    defaultCompileScenarios,
    defaultPreviousWindowGraphOptions,
    defaultTsServerScenarios,
    previousWindowPropertiesScenario,
    scenarioDirectoryName,
    type BenchmarkFixture,
    type BenchmarkConstructionMode,
    type BenchmarkPropertyVisibility,
    type BenchmarkScenario,
    type PreviousWindowGraphOptions
} from "./fixture-generator.js"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated")
const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")
const tsserverFile = path.join(packageRoot, "node_modules", "typescript", "lib", "tsserver.js")
const tsInstance = tsModule as unknown as TypeScript
const transformPassFileName = "/virtual/benchmark-suite-transform-pass.ts"
const transformPassTarget = tsModule.ScriptTarget.ES2022

type BenchmarkMode = "all" | "compile" | "edit" | "transform" | "tsserver"
type BenchmarkTableMode = "compact" | "full"

type BenchmarkResult = {
    scenario   : BenchmarkScenario,
    durations : number[]
}

type DurationResult = {
    name      : string,
    durations : number[]
}

type TransformPassScenario = {
    name             : string,
    mixinCount       : number,
    propertyCount    : number,
    dependencyWindow : number,
    consumerCount    : number
}

type TransformPassFixture = {
    nodes      : number,
    sourceFile : ts.SourceFile,
    statements : number
}

type StepTimings = {
    clone     : number,
    transform : number,
    preserve  : number,
    setParent : number
}

type TransformPassSample = StepTimings & {
    total : number,
    wall  : number
}

type TransformPassResult = {
    scenario   : TransformPassScenario,
    fixture    : TransformPassFixture,
    samples    : TransformPassSample[]
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
const propertyVisibility = benchmarkPropertyVisibility()
const constructionMode = benchmarkConstructionMode()
const editCount = integerEnv("TS_MIXIN_BENCH_EDIT_COUNT", 8)
const transformPassIterations = integerEnv("TS_MIXIN_BENCH_TRANSFORM_ITERATIONS", 80)
const tableMode = benchmarkTableMode()
const graphOptions = previousWindowGraphOptions()
const outputFile = process.env.TS_MIXIN_BENCH_OUTPUT
const reportLines: string[] = []

printSuiteHeader()

if (mode === "all" || mode === "transform") {
    runTransformPassBenchmark()
}

if (mode === "all" || mode === "compile") {
    await runCompileBenchmark()
}

if (mode === "all" || mode === "tsserver") {
    await runTsServerBenchmark()
}

if (mode === "all" || mode === "edit") {
    await runEditBenchmark()
}

await writeBenchmarkOutput()

function runTransformPassBenchmark(): void {
    const results: TransformPassResult[] = []

    for (const scenario of transformPassScenarios()) {
        const fixture = createTransformPassFixture(scenario)

        for (let index = 0; index < warmups; index++) {
            runTransformPassSample(fixture.sourceFile, transformPassIterations)
        }

        const samples: TransformPassSample[] = []

        for (let index = 0; index < iterations; index++) {
            samples.push(runTransformPassSample(fixture.sourceFile, transformPassIterations))
        }

        results.push({ scenario, fixture, samples })
    }

    printTransformPassResults(results)
}

async function runCompileBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of compileScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "compile"),
            scenario
        })

        for (let index = 0; index < warmups; index++) {
            await runCleanCompile(fixture.tsconfigFile, fixture.directory)
        }

        const durations: number[] = []

        for (let index = 0; index < iterations; index++) {
            durations.push(await runCleanCompile(fixture.tsconfigFile, fixture.directory))
        }

        results.push({ scenario, durations })
    }

    printResults("Compile fixtures", results)
}

async function runTsServerBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of tsServerScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "tsserver"),
            scenario
        })

        for (let index = 0; index < warmups; index++) {
            await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile)
        }

        const durations: number[] = []

        for (let index = 0; index < iterations; index++) {
            durations.push(await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile))
        }

        results.push({ scenario, durations })
    }

    printResults("Tsserver diagnostics fixtures", results)
}

async function runEditBenchmark(): Promise<void> {
    const results: BenchmarkResult[] = []

    for (const scenario of editScenarios()) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "edit"),
            scenario
        })

        for (let index = 0; index < warmups; index++) {
            await runEditProcessingRequests(fixture, editCount)
        }

        const durations: number[] = []

        for (let index = 0; index < iterations; index++) {
            durations.push(...await runEditProcessingRequests(fixture, editCount))
        }

        results.push({ scenario, durations })
    }

    printResults("Tsserver edit fixtures", results)
}

function createTransformPassFixture(scenario: TransformPassScenario): TransformPassFixture {
    const sourceFile = tsModule.createSourceFile(
        transformPassFileName,
        generateTransformPassSource(scenario),
        transformPassTarget,
        true,
        tsModule.ScriptKind.TS
    )

    return {
        sourceFile,
        statements : sourceFile.statements.length,
        nodes      : countNodes(sourceFile)
    }
}

function runTransformPassSample(sourceFile: ts.SourceFile, sampleIterations: number): TransformPassSample {
    const totals: StepTimings = { clone : 0, transform : 0, preserve : 0, setParent : 0 }
    const wallStart = performance.now()

    for (let index = 0; index < sampleIterations; index++) {
        runTransformPassOnce(sourceFile, totals)
    }

    const wall = performance.now() - wallStart
    const divisor = Math.max(1, sampleIterations)

    return {
        clone     : totals.clone / divisor,
        transform : totals.transform / divisor,
        preserve  : totals.preserve / divisor,
        setParent : totals.setParent / divisor,
        total     : (totals.clone + totals.transform + totals.preserve + totals.setParent) / divisor,
        wall      : wall / divisor
    }
}

function runTransformPassOnce(sourceFile: ts.SourceFile, into: StepTimings): void {
    let mark = performance.now()
    const cloned = cloneSourceFileForTransform(tsInstance, sourceFile, transformPassTarget)

    into.clone += performance.now() - mark

    mark = performance.now()

    const transformed = transformSourceFile(tsInstance, cloned, { sourceView : true })

    into.transform += performance.now() - mark

    if (transformed === cloned) {
        throw new Error("Generated transform-pass file was not transformed -- mixin detection failed")
    }

    mark = performance.now()
    preserveTopLevelStatementRanges(tsInstance, transformed)
    into.preserve += performance.now() - mark

    mark = performance.now()
    setParentRecursivePreservingVersion(tsInstance, transformed, sourceFile)
    into.setParent += performance.now() - mark
}

function generateTransformPassSource(scenario: TransformPassScenario): string {
    const lines = [ `import { mixin } from "ts-mixin-class"`, "" ]

    for (let index = 0; index < scenario.mixinCount; index++) {
        const dependencies: string[] = []

        for (let offset = 1; offset <= scenario.dependencyWindow && index - offset >= 0; offset++) {
            if ((index + offset) % 2 === 0) {
                dependencies.push(`Mixin${index - offset}`)
            }
        }

        const implementsClause = dependencies.length === 0 ? "" : ` implements ${dependencies.join(", ")}`

        lines.push(`@mixin()`)
        lines.push(`export class Mixin${index}${implementsClause} {`)

        for (let property = 0; property < scenario.propertyCount; property++) {
            lines.push(`    value${index}_${property}: number = ${index * 1000 + property}`)
        }

        lines.push(`}`, "")
    }

    for (let consumer = 0; consumer < scenario.consumerCount; consumer++) {
        const leaves: string[] = []

        for (let index = scenario.mixinCount - 1 - consumer; index >= 0 && leaves.length < 8; index -= 2) {
            leaves.push(`Mixin${index}`)
        }

        lines.push(`export class Consumer${consumer} implements ${leaves.join(", ")} {`, `}`, "")
    }

    return lines.join("\n")
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
    const sizes = scenarioSizes("TS_MIXIN_BENCH_SIZES")

    return sizes === undefined
        ? defaultCompileScenarios(propertyCount, graphOptions, propertyVisibility, constructionMode)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, constructionMode)
        })
}

function tsServerScenarios(): BenchmarkScenario[] {
    const sizes = scenarioSizes("TS_MIXIN_BENCH_TSSERVER_SIZES")

    return sizes === undefined
        ? defaultTsServerScenarios(propertyCount, graphOptions, propertyVisibility, constructionMode)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, constructionMode)
        })
}

function editScenarios(): BenchmarkScenario[] {
    const sizes = scenarioSizes("TS_MIXIN_BENCH_EDIT_SIZES")

    return sizes === undefined
        ? defaultEditScenarios(propertyCount, graphOptions, propertyVisibility, constructionMode)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(size, propertyCount, graphOptions, propertyVisibility, constructionMode)
        })
}

function scenarioSizes(specificEnvName: string): number[] | undefined {
    const sizes = process.env[specificEnvName] ?? process.env.TS_MIXIN_BENCH_SIZES

    return sizes?.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
}

function transformPassScenarios(): TransformPassScenario[] {
    const scenarios = process.env.TS_MIXIN_BENCH_TRANSFORM_SCENARIOS

    if (scenarios === undefined) {
        return defaultTransformPassScenarios()
    }

    return scenarios.split(",")
        .map((scenario) => scenario.trim())
        .filter((scenario) => scenario.length > 0)
        .map((scenario) => {
            const [ mixins, properties, window, consumers ] = scenario.split(":")
                .map((value) => Number.parseInt(value.trim(), 10))

            if (
                !Number.isFinite(mixins) || mixins <= 0 ||
                !Number.isFinite(properties) || properties <= 0 ||
                !Number.isFinite(window) || window < 0 ||
                !Number.isFinite(consumers) || consumers <= 0
            ) {
                throw new Error(
                    "Invalid TS_MIXIN_BENCH_TRANSFORM_SCENARIOS entry " +
                    `${JSON.stringify(scenario)}. Expected mixins:props:window:consumers.`
                )
            }

            return transformPassScenario(mixins, properties, window, consumers)
        })
}

function defaultTransformPassScenarios(): TransformPassScenario[] {
    return [
        transformPassScenario(25, 1, 4, 1),
        transformPassScenario(80, 3, 4, 1),
        transformPassScenario(80, 3, 4, 8),
        transformPassScenario(160, 3, 8, 8)
    ]
}

function transformPassScenario(
    mixinCount: number,
    propertyCount: number,
    dependencyWindow: number,
    consumerCount: number
): TransformPassScenario {
    return {
        name : [
            `mixins-${mixinCount}`,
            `props-${propertyCount}`,
            `window-${dependencyWindow}`,
            `consumers-${consumerCount}`
        ].join("-"),
        mixinCount,
        propertyCount,
        dependencyWindow,
        consumerCount
    }
}

function previousWindowGraphOptions(): PreviousWindowGraphOptions {
    const defaults = defaultPreviousWindowGraphOptions()

    return {
        dependencyWindow   : integerEnv("TS_MIXIN_BENCH_DEP_WINDOW", defaults.dependencyWindow),
        maxDependencyCount : integerEnv("TS_MIXIN_BENCH_DEP_MAX", defaults.maxDependencyCount),
        minDependencyCount : integerEnv("TS_MIXIN_BENCH_DEP_MIN", defaults.minDependencyCount),
        seed               : integerEnv("TS_MIXIN_BENCH_SEED", defaults.seed)
    }
}

function benchmarkMode(): BenchmarkMode {
    const modeArgument = process.argv[2] ?? "all"

    if (
        modeArgument === "all" ||
        modeArgument === "compile" ||
        modeArgument === "edit" ||
        modeArgument === "transform" ||
        modeArgument === "tsserver"
    ) {
        return modeArgument
    }

    throw new Error(`Unknown benchmark mode ${JSON.stringify(modeArgument)}. Use all, compile, edit, transform, or tsserver.`)
}

function benchmarkTableMode(): BenchmarkTableMode {
    const modeName = process.env.TS_MIXIN_BENCH_TABLE ?? "compact"

    if (modeName === "compact" || modeName === "full") {
        return modeName
    }

    throw new Error(`Unknown TS_MIXIN_BENCH_TABLE ${JSON.stringify(modeName)}. Use compact or full.`)
}

function benchmarkPropertyVisibility(): BenchmarkPropertyVisibility {
    const visibility = process.env.TS_MIXIN_BENCH_PROPERTY_VISIBILITY ?? "implicit"

    if (visibility === "implicit" || visibility === "public") {
        return visibility
    }

    throw new Error(
        `Unknown TS_MIXIN_BENCH_PROPERTY_VISIBILITY ${JSON.stringify(visibility)}. Use implicit or public.`
    )
}

function benchmarkConstructionMode(): BenchmarkConstructionMode {
    const construction = process.env.TS_MIXIN_BENCH_CONSTRUCTION ?? "plain"

    if (construction === "plain" || construction === "base") {
        return construction
    }

    throw new Error(`Unknown TS_MIXIN_BENCH_CONSTRUCTION ${JSON.stringify(construction)}. Use plain or base.`)
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
    printDurationResults(title, results.map((result) => {
        return {
            name      : scenarioDirectoryName(result.scenario),
            durations : result.durations
        }
    }))
}

function printSuiteHeader(): void {
    report("ts-mixin-class benchmarks")
    report([
        `groups=${mode}`,
        `samples=${iterations}`,
        `warmups=${warmups}`,
        `table=${tableMode}`
    ].join(" "))

    if (mode === "all" || mode === "transform") {
        report(`transform-pass: innerIterations=${transformPassIterations}`)
    }

    if (mode === "all" || mode === "compile" || mode === "edit" || mode === "tsserver") {
        report([
            "fixtures:",
            `construction=${constructionMode}`,
            `visibility=${propertyVisibility}`,
            `properties=${propertyCount}`,
            `deps=${graphOptions.minDependencyCount}-${graphOptions.maxDependencyCount}`,
            `window=${graphOptions.dependencyWindow}`,
            `seed=${graphOptions.seed}`
        ].join(" "))
    }
}

function printDurationResults(title: string, results: DurationResult[]): void {
    report("")
    report(title)

    if (tableMode === "compact") {
        report([
            "name".padEnd(64),
            "median".padStart(9)
        ].join(" "))

        for (const result of results) {
            const stats = durationStats(result.durations)

            report([
                result.name.padEnd(64),
                formatDuration(stats.median).padStart(9)
            ].join(" "))
        }

        return
    }

    report([
        "name".padEnd(64),
        "min".padStart(9),
        "median".padStart(9),
        "mean".padStart(9),
        "max".padStart(9),
        "samples".padStart(8)
    ].join(" "))

    for (const result of results) {
        const stats = durationStats(result.durations)

        report([
            result.name.padEnd(64),
            formatDuration(stats.min).padStart(9),
            formatDuration(stats.median).padStart(9),
            formatDuration(stats.mean).padStart(9),
            formatDuration(stats.max).padStart(9),
            String(result.durations.length).padStart(8)
        ].join(" "))
    }
}

function printTransformPassResults(results: TransformPassResult[]): void {
    report("")
    report("Transform-pass source-view")

    if (tableMode === "compact") {
        report([
            "name".padEnd(38),
            "median".padStart(9)
        ].join(" "))

        for (const result of results) {
            const totals = result.samples.map((sample) => sample.total)
            const stats = durationStats(totals)

            report([
                result.scenario.name.padEnd(38),
                formatDuration(stats.median).padStart(9)
            ].join(" "))
        }

        return
    }

    report([
        "name".padEnd(38),
        "nodes".padStart(7),
        "min".padStart(9),
        "median".padStart(9),
        "mean".padStart(9),
        "max".padStart(9),
        "clone".padStart(9),
        "xform".padStart(9),
        "ranges".padStart(9),
        "parent".padStart(9),
        "samples".padStart(8)
    ].join(" "))

    for (const result of results) {
        const totals = result.samples.map((sample) => sample.total)
        const stats = durationStats(totals)

        report([
            result.scenario.name.padEnd(38),
            String(result.fixture.nodes).padStart(7),
            formatDuration(stats.min).padStart(9),
            formatDuration(stats.median).padStart(9),
            formatDuration(stats.mean).padStart(9),
            formatDuration(stats.max).padStart(9),
            formatDuration(mean(result.samples.map((sample) => sample.clone))).padStart(9),
            formatDuration(mean(result.samples.map((sample) => sample.transform))).padStart(9),
            formatDuration(mean(result.samples.map((sample) => sample.preserve))).padStart(9),
            formatDuration(mean(result.samples.map((sample) => sample.setParent))).padStart(9),
            String(result.samples.length).padStart(8)
        ].join(" "))
    }
}

function report(line = ""): void {
    console.log(line)
    reportLines.push(line)
}

async function writeBenchmarkOutput(): Promise<void> {
    if (outputFile === undefined) {
        return
    }

    await mkdir(path.dirname(outputFile), { recursive : true })
    await writeFile(outputFile, `${reportLines.join("\n")}\n`)
}

function durationStats(values: number[]): { max: number, mean: number, median: number, min: number } {
    const sorted = [ ...values ].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!

    return {
        max : sorted.at(-1)!,
        mean : mean(sorted),
        min : sorted[0]!,
        median
    }
}

function formatDuration(value: number): string {
    return `${value.toFixed(1)}ms`
}

function mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function countNodes(node: ts.Node): number {
    let count = 1

    tsModule.forEachChild(node, (child) => {
        count += countNodes(child)
    })

    return count
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
