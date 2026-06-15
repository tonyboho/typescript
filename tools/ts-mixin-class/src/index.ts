import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { expandConsumerClass } from "./consumer-expand.js"
import { rewritePublicOnlyUndefinedInitializerClass } from "./construction-initializers.js"
import { isConstructionBaseOptIn } from "./construction-config.js"
import { buildFileMixinContext } from "./context.js"
import { collectMixinDecoratorImports, hasMixinDecorator } from "./decorators.js"
import { createMixinDeclarationDiagnosticAliases } from "./expand-util.js"
import { expandMixinClass } from "./mixin-expand.js"
import { localMixinHeritageTypes } from "./mixin-refs.js"
import {
    anyConstructorName,
    classStaticsName,
    defaultTransformOptions,
    defineMixinClassName,
    extendsClause,
    metadataBaseImportName,
    metadataBaseLocalName,
    mixinApplicationName,
    mixinChainName,
    mixinFactoryName,
    runtimeMixinClassName,
    shouldSkipFileName,
    staticConflictKeysName,
    type CrossFileContext,
    type FileMixinContext,
    type MixinClassTransformerConfig,
    type StaticCollisionCheckMode,
    type TransformOptions
} from "./model.js"
import { buildMixinRegistry, hasRuntimeModuleForDeclaration } from "./registry.js"
import {
    cloneSourceFileForTransform,
    preserveTopLevelStatementRanges,
    printSourceFile,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    zeroWidthRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export * from "./base.js"
export * from "./runtime.js"
export type {
    ConstructionConfigMode,
    CrossFileContext,
    MixinClassTransformerConfig,
    MixinClassTransformerMode,
    MixinRegistry,
    RegisteredMixin,
    StaticCollisionCheckMode
} from "./model.js"
export { hasMixinDecorator } from "./decorators.js"
export { buildMixinRegistry } from "./registry.js"
export { printSourceFile } from "./util.js"

// ---------------------------------------------------------------------------
// ts-patch ProgramTransformer

function resolveTransformOptions(config: MixinClassTransformerConfig): TransformOptions {
    return {
        packageName          : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName        : config.decoratorName ?? defaultTransformOptions.decoratorName,
        sourceView           : false,
        staticCollisionCheck : normalizeStaticCollisionCheck(config.staticCollisionCheck),
        constructionConfig   : config.constructionConfig ?? defaultTransformOptions.constructionConfig,
        allowUndefinedForRequiredProperties :
            config.allowUndefinedForRequiredProperties ??
            defaultTransformOptions.allowUndefinedForRequiredProperties
    }
}

function normalizeStaticCollisionCheck(
    value: MixinClassTransformerConfig["staticCollisionCheck"]
): StaticCollisionCheckMode {
    if (value === undefined) {
        return defaultTransformOptions.staticCollisionCheck
    }

    if (value === true) {
        return "strict"
    }

    return value
}

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions = program.getCompilerOptions()
    const compilerHost    = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options         = resolveTransformOptions(config)

    const resolveModuleFileName = (specifier: string, containingFile: string): string | undefined => {
        return tsInstance.resolveModuleName(specifier, containingFile, compilerOptions, compilerHost)
            .resolvedModule?.resolvedFileName
    }
    const canImportRuntimeValue = (resolvedFileName: string): boolean => {
        return hasRuntimeModuleForDeclaration(tsInstance, compilerHost, resolvedFileName)
    }

    const registry  = buildMixinRegistry(tsInstance, program, options, resolveModuleFileName)
    const crossFile = registry.size === 0 ? undefined : { registry, resolveModuleFileName, canImportRuntimeValue }
    const nextHost  = createMixinClassCompilerHost(tsInstance, compilerHost, compilerOptions, config, crossFile)

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
    compilerOptions: ts.CompilerOptions,
    config: MixinClassTransformerConfig,
    crossFile?: CrossFileContext
): ts.CompilerHost {
    const options = resolveTransformOptions(config)
    const usePrintedSourceFile = resolveUsePrintedSourceFile(config, compilerOptions)

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const sourceFile = compilerHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                usePrintedSourceFile ? shouldCreateNewSourceFile : true
            )

            if (sourceFile === undefined || shouldSkipSourceFile(sourceFile)) {
                return sourceFile
            }

            const transformSourceFileInput = usePrintedSourceFile
                ? sourceFile
                : cloneSourceFileForTransform(tsInstance, sourceFile, languageVersionOrOptions)
            const transformedSourceFile = transformSourceFile(tsInstance, transformSourceFileInput, {
                ...options,
                sourceView : !usePrintedSourceFile
            }, crossFile)

            if (transformedSourceFile === transformSourceFileInput) {
                return sourceFile
            }

            if (!usePrintedSourceFile) {
                preserveTopLevelStatementRanges(tsInstance, transformedSourceFile)
                return setParentRecursivePreservingVersion(tsInstance, transformedSourceFile, sourceFile)
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

// ---------------------------------------------------------------------------
// Source file transformation

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: Partial<TransformOptions> = {},
    crossFile?: CrossFileContext
): ts.SourceFile {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    if (crossFile === undefined && !sourceFile.text.includes(resolvedOptions.packageName)) {
        return sourceFile
    }

    const mixinDecoratorImports = collectMixinDecoratorImports(tsInstance, sourceFile, resolvedOptions)
    const context               = buildFileMixinContext(
        tsInstance, sourceFile, mixinDecoratorImports, resolvedOptions, crossFile
    )

    const hasAnonymousMixinDiagnostics = sourceFile.statements.some((statement) => {
        return tsInstance.isClassDeclaration(statement) &&
            statement.name === undefined &&
            hasMixinDecorator(tsInstance, statement, mixinDecoratorImports, resolvedOptions)
    })
    const hasAnonymousConsumerDiagnostics = sourceFile.statements.some((statement) => {
        return tsInstance.isClassDeclaration(statement) &&
            statement.name === undefined &&
            localMixinHeritageTypes(tsInstance, statement, context).length > 0
    })

    let expandedAnything = false
    let needsGeneratedImports = false

    const expandedStatements = sourceFile.statements.flatMap((statement): ts.Statement[] => {
        if (tsInstance.isClassDeclaration(statement) && statement.name === undefined &&
            hasMixinDecorator(tsInstance, statement, mixinDecoratorImports, resolvedOptions)
        ) {
            expandedAnything = true
            return anonymousClassDiagnosticStatements(
                tsInstance,
                statement,
                "AnonymousDefaultMixin",
                "Invalid mixin class declaration. A default-exported mixin class must be named. " +
                    "Write `export default class MyMixin` so the transformer can generate stable interface, factory, registry, and declaration names."
            )
        }

        if (tsInstance.isClassDeclaration(statement) && statement.name === undefined &&
            localMixinHeritageTypes(tsInstance, statement, context).length > 0
        ) {
            expandedAnything = true
            return anonymousClassDiagnosticStatements(
                tsInstance,
                statement,
                "AnonymousMixinConsumer",
                "Invalid mixin consumer declaration. A mixin consumer class must be named. " +
                    "Write `class Consumer implements Mixin` or `export default class Consumer implements Mixin` " +
                    "so the transformer can generate stable intermediate base, diagnostic, and declaration names."
            )
        }

        if (tsInstance.isClassDeclaration(statement) && statement.name !== undefined) {
            const ref = context.byLocalName.get(statement.name.text)

            if (ref !== undefined && ref.declaration === statement) {
                expandedAnything = true
                needsGeneratedImports = true
                return expandMixinClass(tsInstance, sourceFile, ref, context, resolvedOptions)
            }

            const mixinHeritage = localMixinHeritageTypes(tsInstance, statement, context)

            if (mixinHeritage.length > 0) {
                expandedAnything = true
                needsGeneratedImports = true
                return expandConsumerClass(tsInstance, sourceFile, statement, context, resolvedOptions, mixinHeritage)
            }

            if (isConstructionBaseOptIn(
                tsInstance,
                sourceFile,
                extendsClause(tsInstance, statement)?.types[0],
                resolvedOptions
            )) {
                const rewrittenStatement = rewritePublicOnlyUndefinedInitializerClass(
                    tsInstance,
                    statement,
                    resolvedOptions
                )

                if (rewrittenStatement !== statement) {
                    expandedAnything = true
                    return [ rewrittenStatement ]
                }
            }
        }

        return [ statement ]
    })

    if (!expandedAnything) {
        return sourceFile
    }

    return tsInstance.factory.updateSourceFile(
        sourceFile,
        needsGeneratedImports
            ? insertGeneratedImports(tsInstance, expandedStatements, context, resolvedOptions)
            : expandedStatements
    )
}

function anonymousClassDiagnosticStatements(
    tsInstance: TypeScript,
    statement: ts.ClassDeclaration,
    generatedBaseName: string,
    message: string
): ts.Statement[] {
    return [
        ...createMixinDeclarationDiagnosticAliases(
            tsInstance,
            generatedBaseName,
            [ {
                node : statement,
                message
            } ],
            statement
        ),
        statement
    ]
}

// Generated imports (type helpers + mixin factories from other modules) are
// inserted after the last original import.
function insertGeneratedImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory = tsInstance.factory

    const generatedImports: ts.ImportDeclaration[] = [ createHelperTypeImport(tsInstance, context, options) ]

    const bySpecifier = new Map<string, Array<{ importedName: string, localName: string }>>()

    for (const factoryImport of context.usedFactoryImports.values()) {
        const elements = bySpecifier.get(factoryImport.specifier) ?? []

        elements.push(factoryImport)
        bySpecifier.set(factoryImport.specifier, elements)
    }

    for (const [ specifier, elements ] of bySpecifier) {
        generatedImports.push(factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
                undefined,
                undefined,
                factory.createNamedImports(elements.map((element) => {
                    return factory.createImportSpecifier(
                        false,
                        element.importedName === element.localName
                            ? undefined
                            : factory.createIdentifier(element.importedName),
                        factory.createIdentifier(element.localName)
                    )
                }))
            ),
            factory.createStringLiteral(specifier)
        ))
    }

    let lastImportIndex = -1

    for (let index = 0; index < statements.length; index++) {
        if (tsInstance.isImportDeclaration(statements[index])) {
            lastImportIndex = index
        }
    }

    return [
        ...statements.slice(0, lastImportIndex + 1),
        ...generatedImports,
        ...statements.slice(lastImportIndex + 1)
    ]
}

// ---------------------------------------------------------------------------
// Helper builders

function createHelperTypeImport(
    tsInstance: TypeScript,
    context: FileMixinContext,
    options: TransformOptions
): ts.ImportDeclaration {
    const factory = tsInstance.factory
    const staticConflictImport = options.staticCollisionCheck === false
        ? []
        : [
            factory.createImportSpecifier(
                true,
                undefined,
                factory.createIdentifier(staticConflictKeysName(options.staticCollisionCheck))
            )
        ]

    return factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
            undefined,
            undefined,
            factory.createNamedImports([
                factory.createImportSpecifier(false, undefined, factory.createIdentifier(defineMixinClassName)),
                factory.createImportSpecifier(false, undefined, factory.createIdentifier(mixinChainName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(anyConstructorName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(classStaticsName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(mixinApplicationName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(mixinFactoryName)),
                ...staticConflictImport,
                factory.createImportSpecifier(
                    true,
                    factory.createIdentifier(metadataBaseImportName),
                    factory.createIdentifier(metadataBaseLocalName)
                ),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(runtimeMixinClassName))
            ])
        ),
        factory.createStringLiteral(options.packageName)
    )
}

function shouldSkipSourceFile(sourceFile: ts.SourceFile): boolean {
    return sourceFile.isDeclarationFile || shouldSkipFileName(sourceFile.fileName)
}

function resolveUsePrintedSourceFile(
    config: MixinClassTransformerConfig,
    compilerOptions: ts.CompilerOptions
): boolean {
    const mode = config.mode

    if (mode === undefined) {
        if (isTypeScriptServerProcess()) {
            return false
        }

        return shouldCreatePrintedSourceFileForEmit(compilerOptions)
    }

    if (mode !== "emit" && mode !== "ide") {
        throw new Error(`ts-mixin-class: unknown "mode" option ${JSON.stringify(mode)}, expected "emit" or "ide".`)
    }

    return mode === "emit"
}

function shouldCreatePrintedSourceFileForEmit(compilerOptions: ts.CompilerOptions): boolean {
    return !compilerOptions.noEmit && !isTypeScriptServerProcess()
}

function isTypeScriptServerProcess(): boolean {
    const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? []

    return argv.some((argument) => {
        const fileName = argument.replaceAll("\\", "/").split("/").at(-1)

        return fileName === "tsserver.js" || fileName === "_tsserver.js"
    })
}
