import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createLazyPropertyCompilerHost } from "../src/index.js"
import type { LazyPropertyTransformerConfig } from "../src/index.js"
import { findFirst, trimIndent } from "./util.js"

const sourceFileName = "source.ts"

const sourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class SourceClass {
        @lazy()
        lazyProperty: string = "init"
    }
`)

const updatedSourceText = sourceText.replace('"init"', '"updated"')

const preserveCompilerOptions: ts.CompilerOptions = {
    target                 : ts.ScriptTarget.ES2022,
    module                 : ts.ModuleKind.ESNext,
    moduleResolution       : ts.ModuleResolutionKind.Bundler,
    strict                 : true,
    skipLibCheck           : true,
    noEmit                 : true,
    experimentalDecorators : false
}

it("reuses the transformed source file while the layered source file is unchanged", async (t: Test) => {
    const files       = new Map([ [ sourceFileName, sourceText ] ])
    const memoryHost  = createMemoryCompilerHost(files, preserveCompilerOptions)
    const baseProgram = ts.createProgram([ sourceFileName ], preserveCompilerOptions, memoryHost)

    const first  = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, {}, baseProgram)
    const second = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, {}, baseProgram)

    t.true(first === second, "Unchanged layered source file returns the cached transformed source file across host instances")
    t.true(first !== baseProgram.getSourceFile(sourceFileName), "Cached source file is not the base program source file")
    t.is(first.text, sourceText, "Preserve mode keeps the original source text")
    t.true(
        findFirst(first, ts.isGetAccessorDeclaration) !== undefined,
        "Cached source file contains the generated lazy getter"
    )
})

it("does not reuse the cached source file after the layered source file changes", async (t: Test) => {
    const files       = new Map([ [ sourceFileName, sourceText ] ])
    const memoryHost  = createMemoryCompilerHost(files, preserveCompilerOptions)
    const baseProgram = ts.createProgram([ sourceFileName ], preserveCompilerOptions, memoryHost)
    const first       = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, {}, baseProgram)

    files.set(sourceFileName, updatedSourceText)

    const nextBaseProgram = ts.createProgram([ sourceFileName ], preserveCompilerOptions, memoryHost)
    const next            = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, {}, nextBaseProgram)

    t.true(next !== first, "Changed layered source file misses the cache")
    t.is(next.text, updatedSourceText, "Transformed source file reflects the updated text")
})

it("does not share cached source files between different transform options", async (t: Test) => {
    const files       = new Map([ [ sourceFileName, sourceText ] ])
    const memoryHost  = createMemoryCompilerHost(files, preserveCompilerOptions)
    const baseProgram = ts.createProgram([ sourceFileName ], preserveCompilerOptions, memoryHost)

    const defaultPrefix = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, {}, baseProgram)
    const customPrefix  = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, { backingPrefix : "__" }, baseProgram)

    t.true(defaultPrefix !== customPrefix, "Different transform options produce different cache entries")
    t.true(
        findFirst(customPrefix, isBackingProperty("__lazyProperty")) !== undefined,
        "Custom prefix source file contains the __lazyProperty backing property"
    )
    t.true(
        findFirst(defaultPrefix, isBackingProperty("$lazyProperty")) !== undefined,
        "Default prefix source file contains the $lazyProperty backing property"
    )
})

it('mode "ide" overrides the emit heuristic', async (t: Test) => {
    const emitCapableOptions: ts.CompilerOptions = {
        ...preserveCompilerOptions,
        noEmit : false
    }
    const files       = new Map([ [ sourceFileName, sourceText ] ])
    const memoryHost  = createMemoryCompilerHost(files, emitCapableOptions)
    const baseProgram = ts.createProgram([ sourceFileName ], emitCapableOptions, memoryHost)
    const sourceFile  = getTransformedSourceFile(t, memoryHost, emitCapableOptions, { mode : "ide" }, baseProgram)

    t.is(sourceFile.text, sourceText, 'mode "ide" keeps the original source text despite emit-capable compiler options')
    t.true(
        findFirst(sourceFile, ts.isGetAccessorDeclaration) !== undefined,
        'mode "ide" source file contains the generated lazy getter'
    )
})

it('mode "emit" overrides the noEmit heuristic', async (t: Test) => {
    const files       = new Map([ [ sourceFileName, sourceText ] ])
    const memoryHost  = createMemoryCompilerHost(files, preserveCompilerOptions)
    const baseProgram = ts.createProgram([ sourceFileName ], preserveCompilerOptions, memoryHost)
    const sourceFile  = getTransformedSourceFile(t, memoryHost, preserveCompilerOptions, { mode : "emit" }, baseProgram)

    t.true(sourceFile.text !== sourceText, 'mode "emit" replaces the source text despite noEmit')
    t.true(
        sourceFile.text.includes("$lazyProperty"),
        'mode "emit" source text contains the printed backing property'
    )
})

it("unknown mode option throws", async (t: Test) => {
    const memoryHost = createMemoryCompilerHost(new Map(), preserveCompilerOptions)

    let error: Error | undefined

    try {
        createLazyPropertyCompilerHost(ts, memoryHost, preserveCompilerOptions, { mode : "watch" } as unknown as LazyPropertyTransformerConfig)
    } catch (caught) {
        error = caught as Error
    }

    t.true(
        error !== undefined && /"mode"/.test(error.message),
        `Unknown mode option throws a descriptive error: ${error?.message}`
    )
})

function createMemoryCompilerHost(
    files: Map<string, string>,
    compilerOptions: ts.CompilerOptions
): ts.CompilerHost {
    const host = ts.createCompilerHost(compilerOptions, true)
    const originalGetSourceFile = host.getSourceFile.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const text = files.get(fileName)

        if (text !== undefined) {
            return ts.createSourceFile(fileName, text, languageVersionOrOptions, true, ts.ScriptKind.TS)
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    return host
}

function getTransformedSourceFile(
    t: Test,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: LazyPropertyTransformerConfig,
    baseProgram: ts.Program
): ts.SourceFile {
    const lazyHost   = createLazyPropertyCompilerHost(ts, compilerHost, compilerOptions, config, baseProgram)
    const sourceFile = lazyHost.getSourceFile(sourceFileName, ts.ScriptTarget.ES2022, undefined, false)

    if (sourceFile === undefined) {
        t.fail("Missing transformed source file.")
        throw new Error("Missing transformed source file.")
    }

    return sourceFile
}

function isBackingProperty(name: string): (node: ts.Node) => node is ts.PropertyDeclaration {
    return (node): node is ts.PropertyDeclaration => {
        return ts.isPropertyDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
    }
}
