import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createLazyPropertyCompilerHost } from "../src/index.js"
import { trimIndent } from "./util.js"

const sourceText = trimIndent(`
    import { lazy } from "ts-lazy-property"

    class DependencyClass {
        @lazy()
        lazyProperty: string = "ok"
    }
`)

it("skips node_modules source files with posix and windows path separators", async (t: Test) => {
    const compilerOptions = {
        target                 : ts.ScriptTarget.ES2022,
        module                 : ts.ModuleKind.ESNext,
        moduleResolution       : ts.ModuleResolutionKind.Bundler,
        strict                 : true,
        skipLibCheck           : true,
        noEmit                 : true,
        experimentalDecorators : false
    }

    for (const fileName of [
        "/project/node_modules/dependency/source.ts",
        "C:\\project\\node_modules\\dependency\\source.ts"
    ]) {
        const sourceFile = ts.createSourceFile(
            fileName,
            sourceText,
            ts.ScriptTarget.ES2022,
            true,
            ts.ScriptKind.TS
        )
        const compilerHost = ts.createCompilerHost(compilerOptions, true)
        const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost)

        compilerHost.getSourceFile = (requestedFileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
            if (requestedFileName === fileName) {
                return sourceFile
            }

            return originalGetSourceFile(requestedFileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        }

        const nextHost = createLazyPropertyCompilerHost(ts, compilerHost, compilerOptions, {})
        const result   = nextHost.getSourceFile(fileName, ts.ScriptTarget.ES2022)

        t.equal(result, sourceFile, `Keeps ${fileName} source file untouched`)
    }
})
