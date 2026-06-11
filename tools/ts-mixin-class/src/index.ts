import type * as ts from "typescript"
import type { PluginConfig, ProgramTransformerExtras } from "ts-patch"

type TypeScript = ProgramTransformerExtras["ts"]

export type MixinClassTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string
}

type TransformOptions = {
    packageName : string,
    decoratorName : string
}

type MixinDecoratorImports = {
    identifiers : Set<string>,
    namespaces  : Set<string>
}

const defaultTransformOptions: TransformOptions = {
    packageName   : "ts-mixin-class",
    decoratorName : "mixin"
}

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

function resolveTransformOptions(config: MixinClassTransformerConfig): TransformOptions {
    return {
        packageName   : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName : config.decoratorName ?? defaultTransformOptions.decoratorName
    }
}

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions = program.getCompilerOptions()
    const compilerHost    = host ?? tsInstance.createCompilerHost(compilerOptions)
    const nextHost        = createMixinClassCompilerHost(tsInstance, compilerHost, config)

    return tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        undefined
    )
}

export function createMixinClassCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    config: MixinClassTransformerConfig
): ts.CompilerHost {
    const options = resolveTransformOptions(config)

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const sourceFile = compilerHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                shouldCreateNewSourceFile
            )

            if (sourceFile === undefined || shouldSkipSourceFile(sourceFile)) {
                return sourceFile
            }

            const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options)

            if (transformedSourceFile === sourceFile) {
                return sourceFile
            }

            return tsInstance.createSourceFile(
                fileName,
                printSourceFile(tsInstance, transformedSourceFile),
                languageVersionOrOptions,
                true,
                scriptKindFromFileName(tsInstance, fileName)
            )
        }
    }
}

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: Partial<TransformOptions> = {}
): ts.SourceFile {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    if (!sourceFile.text.includes(resolvedOptions.packageName)) {
        return sourceFile
    }

    const mixinDecoratorImports = collectMixinDecoratorImports(tsInstance, sourceFile, resolvedOptions)

    if (mixinDecoratorImports.identifiers.size === 0 && mixinDecoratorImports.namespaces.size === 0) {
        return sourceFile
    }

    hasMixinClass(tsInstance, sourceFile, mixinDecoratorImports, resolvedOptions)

    return sourceFile
}

export function hasMixinDecorator(
    tsInstance: TypeScript,
    node: ts.HasDecorators,
    imports: MixinDecoratorImports,
    options: Partial<TransformOptions> = {}
): boolean {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    return tsInstance.getDecorators(node)?.some((decorator) => {
        return isMixinDecorator(tsInstance, decorator, imports, resolvedOptions)
    }) ?? false
}

export function printSourceFile(tsInstance: TypeScript, sourceFile: ts.SourceFile): string {
    return tsInstance.createPrinter({ newLine : tsInstance.NewLineKind.LineFeed }).printFile(sourceFile)
}

function hasMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions
): boolean {
    let found = false

    const visit = (node: ts.Node): void => {
        if (found) {
            return
        }

        if ((tsInstance.isClassDeclaration(node) || tsInstance.isClassExpression(node)) &&
            hasMixinDecorator(tsInstance, node, imports, options)
        ) {
            found = true
            return
        }

        tsInstance.forEachChild(node, visit)
    }

    visit(sourceFile)

    return found
}

function isMixinDecorator(
    tsInstance: TypeScript,
    decorator: ts.Decorator,
    imports: MixinDecoratorImports,
    options: TransformOptions
): boolean {
    const expression = decorator.expression

    if (tsInstance.isCallExpression(expression)) {
        return isMixinDecoratorExpression(tsInstance, expression.expression, imports, options)
    }

    return isMixinDecoratorExpression(tsInstance, expression, imports, options)
}

function isMixinDecoratorExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    imports: MixinDecoratorImports,
    options: TransformOptions
): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return imports.identifiers.has(expression.text)
    }

    if (!tsInstance.isPropertyAccessExpression(expression)) {
        return false
    }

    return tsInstance.isIdentifier(expression.expression) &&
        imports.namespaces.has(expression.expression.text) &&
        expression.name.text === options.decoratorName
}

function collectMixinDecoratorImports(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): MixinDecoratorImports {
    const imports = {
        identifiers : new Set<string>(),
        namespaces  : new Set<string>()
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== options.packageName
        ) {
            continue
        }

        const namedBindings = statement.importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings)) {
            imports.namespaces.add(namedBindings.name.text)
            continue
        }

        for (const element of namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text

            if (importedName === options.decoratorName) {
                imports.identifiers.add(element.name.text)
            }
        }
    }

    return imports
}

function shouldSkipSourceFile(sourceFile: ts.SourceFile): boolean {
    return sourceFile.isDeclarationFile || shouldSkipFileName(sourceFile.fileName)
}

function shouldSkipFileName(fileName: string): boolean {
    const normalizedFileName = fileName.replaceAll("\\", "/")

    return normalizedFileName.includes("/node_modules/") ||
        normalizedFileName.endsWith(".d.ts") ||
        !/\.[cm]?tsx?$/.test(normalizedFileName)
}

function scriptKindFromFileName(tsInstance: TypeScript, fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx") || fileName.endsWith(".mtsx") || fileName.endsWith(".ctsx")) {
        return tsInstance.ScriptKind.TSX
    }

    return tsInstance.ScriptKind.TS
}
