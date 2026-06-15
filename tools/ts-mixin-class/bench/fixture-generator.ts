import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

export type BenchmarkGraphKind = "binary-tree"
export type BenchmarkMemberKind = "public-properties"

export type BenchmarkScenario = {
    name              : string,
    size              : number,
    graph             : BenchmarkGraphKind,
    members           : BenchmarkMemberKind,
    consumerLeafCount : number
}

export type BenchmarkFixture = {
    directory    : string,
    tsconfigFile : string,
    consumerFile : string
}

export type CreateBenchmarkFixtureOptions = {
    packageRoot : string,
    root        : string,
    scenario    : BenchmarkScenario
}

type SourceFile = {
    fileName : string,
    text     : string
}

export async function createBenchmarkFixture(options: CreateBenchmarkFixtureOptions): Promise<BenchmarkFixture> {
    const directory = path.join(options.root, scenarioDirectoryName(options.scenario))

    await rm(directory, { force : true, recursive : true })
    await mkdir(directory, { recursive : true })

    const sourceFiles = generateSourceFiles(options.scenario)

    await writeJson(path.join(directory, "package.json"), {
        name    : `ts-mixin-class-bench-${options.scenario.name}`,
        private : true,
        type    : "module"
    })
    await writeJson(path.join(directory, "tsconfig.json"), createTsconfig())

    for (const sourceFile of sourceFiles) {
        const fileName = path.join(directory, sourceFile.fileName)

        await mkdir(path.dirname(fileName), { recursive : true })
        await writeFile(fileName, sourceFile.text)
    }

    await linkNodeModules(options.packageRoot, directory)

    return {
        directory,
        tsconfigFile : path.join(directory, "tsconfig.json"),
        consumerFile : path.join(directory, "src", "consumer.ts")
    }
}

export function defaultCompileScenarios(): BenchmarkScenario[] {
    return [ 25, 100, 250 ].map((size) => {
        return {
            name              : `binary-tree-${size}-public-properties`,
            size,
            graph             : "binary-tree",
            members           : "public-properties",
            consumerLeafCount : Math.min(8, Math.max(1, Math.ceil(size / 32)))
        }
    })
}

export function scenarioDirectoryName(scenario: BenchmarkScenario): string {
    return scenario.name.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")
}

function generateSourceFiles(scenario: BenchmarkScenario): SourceFile[] {
    if (scenario.size < 1) {
        throw new Error(`Benchmark scenario ${scenario.name} must contain at least one mixin`)
    }

    if (scenario.graph !== "binary-tree") {
        throw new Error(`Unsupported benchmark graph: ${scenario.graph}`)
    }

    if (scenario.members !== "public-properties") {
        throw new Error(`Unsupported benchmark member kind: ${scenario.members}`)
    }

    return [
        ...Array.from({ length : scenario.size }, (_, index) => {
            return {
                fileName : `src/${mixinModuleName(index)}.ts`,
                text     : mixinSource(index)
            }
        }),
        {
            fileName : "src/consumer.ts",
            text     : consumerSource(scenario)
        }
    ]
}

function mixinSource(index: number): string {
    const parentIndex = index === 0 ? undefined : Math.floor((index - 1) / 2)
    const imports = [
        `import { mixin } from "ts-mixin-class"`,
        ...(parentIndex === undefined
            ? []
            : [ `import { ${mixinClassName(parentIndex)} } from "./${mixinModuleName(parentIndex)}.js"` ])
    ]
    const implementsClause = parentIndex === undefined
        ? ""
        : ` implements ${mixinClassName(parentIndex)}`

    return `${imports.join("\n")}

@mixin()
export class ${mixinClassName(index)}${implementsClause} {
    value${index}: number = ${index}

    getValue${index}(): number {
        return this.value${index}
    }
}
`
}

function consumerSource(scenario: BenchmarkScenario): string {
    const leafIndexes = consumerLeafIndexes(scenario.size, scenario.consumerLeafCount)
    const imports = leafIndexes.map((index) => {
        return `import { ${mixinClassName(index)} } from "./${mixinModuleName(index)}.js"`
    })
    const implementsClause = leafIndexes.map((index) => mixinClassName(index)).join(", ")
    const checks = leafIndexes.map((index) => {
        return `consumer.getValue${index}()`
    })

    return `${imports.join("\n")}

export class Consumer implements ${implementsClause} {
}

const consumer = new Consumer()

${checks.map((check) => `void ${check}`).join("\n")}
`
}

function consumerLeafIndexes(size: number, count: number): number[] {
    const firstLeaf = Math.floor(size / 2)
    const leaves = Array.from({ length : size - firstLeaf }, (_, offset) => firstLeaf + offset)

    return leaves.slice(-Math.min(count, leaves.length))
}

function mixinClassName(index: number): string {
    return `Mixin${index}`
}

function mixinModuleName(index: number): string {
    return `mixin-${String(index).padStart(4, "0")}`
}

function createTsconfig(): unknown {
    return {
        compilerOptions : {
            target                  : "ES2022",
            module                  : "NodeNext",
            moduleResolution        : "NodeNext",
            lib                     : [ "ES2022" ],
            useDefineForClassFields : false,
            skipLibCheck            : true,
            strict                  : true,
            rootDir                 : "src",
            outDir                  : "dist",
            plugins                 : [
                {
                    transform        : "ts-mixin-class",
                    transformProgram : true
                }
            ]
        },
        include : [ "src/**/*.ts" ]
    }
}

async function linkNodeModules(packageRoot: string, directory: string): Promise<void> {
    const nodeModules = path.join(directory, "node_modules")

    await mkdir(nodeModules, { recursive : true })
    await symlink(packageRoot, path.join(nodeModules, "ts-mixin-class"), "dir")
    await symlink(path.join(packageRoot, "node_modules", "typescript"), path.join(nodeModules, "typescript"), "dir")
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
    await writeFile(fileName, `${JSON.stringify(value, null, 4)}\n`)
}
