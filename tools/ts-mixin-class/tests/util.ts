import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

// dist/tests/util.js -> корень пакета
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function createSourceFile(text: string): ts.SourceFile {
    return ts.createSourceFile(
        "source.ts",
        trimIndent(text),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
}

export function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(...lines
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}

export function findFirst<Node extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is Node
): Node | undefined {
    let found: Node | undefined

    const visit = (node: ts.Node): void => {
        if (found !== undefined) {
            return
        }

        if (predicate(node)) {
            found = node
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(root)

    return found
}

// Полноценный тайпчек текста как модуля, импортирующего "ts-mixin-class":
// пакет резолвится в локальный src/index.ts, остальное — обычный node resolution
export function typecheckText(text: string): string[] {
    const virtualFileName = path.join(packageRoot, "typecheck-virtual-test.ts")

    const options: ts.CompilerOptions = {
        strict                  : true,
        target                  : ts.ScriptTarget.ES2022,
        module                  : ts.ModuleKind.NodeNext,
        moduleResolution        : ts.ModuleResolutionKind.NodeNext,
        useDefineForClassFields : false,
        noEmit                  : true,
        skipLibCheck            : true,
        types                   : [ "node" ]
    }

    const host = ts.createCompilerHost(options)

    const originalGetSourceFile = host.getSourceFile.bind(host)
    const originalFileExists    = host.fileExists.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (path.resolve(fileName) === virtualFileName) {
            return ts.createSourceFile(virtualFileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    host.fileExists = (fileName) => {
        return path.resolve(fileName) === virtualFileName || originalFileExists(fileName)
    }

    host.resolveModuleNameLiterals = (moduleLiterals, containingFile, _redirectedReference, compilerOptions) => {
        return moduleLiterals.map((literal) => {
            if (literal.text === "ts-mixin-class") {
                return {
                    resolvedModule : {
                        resolvedFileName        : path.join(packageRoot, "src", "index.ts"),
                        extension               : ts.Extension.Ts,
                        isExternalLibraryImport : false
                    }
                }
            }

            return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
        })
    }

    const program = ts.createProgram([ virtualFileName ], options, host)

    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
        const message  = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        const location = diagnostic.file !== undefined && diagnostic.start !== undefined
            ? `(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1})`
            : ""

        return `TS${diagnostic.code}${location}: ${message}`
    })
}
