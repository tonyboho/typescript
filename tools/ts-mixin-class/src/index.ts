import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { buildFileMixinContext } from "./context.js"
import { collectMixinDecoratorImports, hasMixinDecorator, isPackageImport } from "./decorators.js"
import { buildInterfaceMembers, interfaceDeclarationRange } from "./interface-members.js"
import { linearizeDependencies } from "./linearization.js"
import {
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    consumerEmptyBaseSuffix,
    defaultTransformOptions,
    defineMixinClassName,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    implementsTypes,
    instanceConfigProperties,
    isNamedClassElement,
    metadataBaseImportName,
    metadataBaseLocalName,
    mixinChainName,
    mixinFactoryName,
    mixinFactorySuffix,
    normalizePath,
    propertyNameText,
    requiredBaseIdentifierName,
    requiredBaseType,
    runtimeMixinClassName,
    staticNeverConflictKeysName,
    staticStrictConflictKeysName,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionConfigMode,
    type CrossFileContext,
    type FileMixinContext,
    type MixinClassTransformerConfig,
    type MixinDeclarationDiagnostic,
    type RequiredBaseRequirement,
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type StaticCollisionCheckMode,
    type StaticSource,
    type TransformOptions
} from "./model.js"
import { buildMixinRegistry, hasRuntimeModuleForDeclaration } from "./registry.js"
import {
    cloneNode,
    cloneOptionalNode,
    cloneSourceFileForTransform,
    deepCloneNode,
    generatedTextRange,
    hasModifier,
    preserveGeneratedDeclarationRange,
    preserveSourceViewGeneratedClassLikeRange,
    preserveSubtreeTextRange,
    preserveTextRange,
    preserveTopLevelStatementRanges,
    printSourceFile,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    zeroWidthRange
} from "./util.js"
import type { TypeScript } from "./util.js"

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
        constructionConfig   : config.constructionConfig ?? defaultTransformOptions.constructionConfig
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
            consumedMixins(tsInstance, statement, context).length > 0
    })

    if (context.byLocalName.size === 0 && !hasAnonymousMixinDiagnostics && !hasAnonymousConsumerDiagnostics) {
        return sourceFile
    }

    let expandedAnything = false

    const expandedStatements = sourceFile.statements.flatMap((statement): ts.Statement[] => {
        if (tsInstance.isClassDeclaration(statement) && statement.name === undefined &&
            hasMixinDecorator(tsInstance, statement, mixinDecoratorImports, resolvedOptions)
        ) {
            expandedAnything = true
            return [
                ...createMixinDeclarationDiagnosticAliases(
                    tsInstance,
                    "AnonymousDefaultMixin",
                    [ {
                        node    : statement,
                        message : "Invalid mixin class declaration. A default-exported mixin class must be named. " +
                            "Write `export default class MyMixin` so the transformer can generate stable interface, factory, registry, and declaration names."
                    } ],
                    statement
                ),
                statement
            ]
        }

        if (tsInstance.isClassDeclaration(statement) && statement.name === undefined &&
            consumedMixins(tsInstance, statement, context).length > 0
        ) {
            expandedAnything = true
            return [
                ...createMixinDeclarationDiagnosticAliases(
                    tsInstance,
                    "AnonymousMixinConsumer",
                    [ {
                        node    : statement,
                        message : "Invalid mixin consumer declaration. A mixin consumer class must be named. " +
                            "Write `class Consumer implements Mixin` or `export default class Consumer implements Mixin` " +
                            "so the transformer can generate stable intermediate base, diagnostic, and declaration names."
                    } ],
                    statement
                ),
                statement
            ]
        }

        if (tsInstance.isClassDeclaration(statement) && statement.name !== undefined) {
            const ref = context.byLocalName.get(statement.name.text)

            if (ref !== undefined && ref.declaration === statement) {
                expandedAnything = true
                return expandMixinClass(tsInstance, sourceFile, ref, context, resolvedOptions)
            }

            if (consumedMixins(tsInstance, statement, context).length > 0) {
                expandedAnything = true
                return expandConsumerClass(tsInstance, sourceFile, statement, context, resolvedOptions)
            }
        }

        return [ statement ]
    })

    if (!expandedAnything) {
        return sourceFile
    }

    return tsInstance.factory.updateSourceFile(
        sourceFile,
        insertGeneratedImports(tsInstance, expandedStatements, context, resolvedOptions)
    )
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

function collectMixinClassDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): MixinDeclarationDiagnostic[] {
    const diagnostics: MixinDeclarationDiagnostic[] = []
    const className = declaration.name?.text ?? "<anonymous mixin>"

    if (hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.AbstractKeyword)) {
        diagnostics.push({
            node    : declaration,
            message : "Invalid mixin class declaration. " +
                `Mixin class ${className} cannot be abstract. ` +
                "Mixin classes are concrete runtime factories; remove the abstract modifier and provide concrete members."
        })
    }

    for (const member of declaration.members) {
        if (tsInstance.isConstructorDeclaration(member)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} cannot declare a constructor. ` +
                    "Mixin constructors cannot be composed safely; use field initializers or explicit initialization methods instead."
            })
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword)
        ) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot be private or protected. Mixin members must be public because they are copied into generated structural interfaces."
            })
        }

        if (isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot use ECMAScript private names. Mixin classes are structurally composed, and #private fields cannot be represented in the generated mixin interface."
            })
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot be abstract. Mixin runtime factories need concrete member implementations."
            })
        }

        if (tsInstance.isPropertyDeclaration(member) && member.type === undefined) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} property ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "must have an explicit type annotation. The transformer needs an explicit type to generate the public mixin interface."
            })
        }

        if (tsInstance.isMethodDeclaration(member)) {
            if (member.type === undefined) {
                diagnostics.push({
                    node    : member,
                    message : "Invalid mixin class declaration. " +
                        `Mixin class ${className} method ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                        "must have an explicit return type annotation. The transformer needs an explicit return type to generate the public mixin interface."
                })
            }

            for (const parameter of member.parameters) {
                if (parameter.type === undefined) {
                    diagnostics.push({
                        node    : parameter,
                        message : "Invalid mixin class declaration. " +
                            `Mixin class ${className} method parameter ${parameterNameForDiagnostic(tsInstance, sourceFile, parameter)} ` +
                            "must have an explicit type annotation. The transformer needs explicit parameter types to generate the public mixin interface."
                    })
                }
            }
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const accessorType = tsInstance.isGetAccessorDeclaration(member)
                ? member.type
                : member.parameters[0]?.type

            if (accessorType === undefined) {
                diagnostics.push({
                    node    : member,
                    message : "Invalid mixin class declaration. " +
                        `Mixin class ${className} accessor ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                        "must have an explicit type annotation. Add a getter return type or a setter parameter type so the transformer can generate the public mixin interface."
                })
            }
        }

        if (!isSupportedMixinClassMember(tsInstance, member)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "is not supported by the mixin transformer. Use fields, methods, or accessors with explicit public types."
            })
        }
    }

    return diagnostics
}

function isSupportedMixinClassMember(tsInstance: TypeScript, member: ts.ClassElement): boolean {
    return tsInstance.isConstructorDeclaration(member) ||
        tsInstance.isPropertyDeclaration(member) ||
        tsInstance.isMethodDeclaration(member) ||
        tsInstance.isGetAccessorDeclaration(member) ||
        tsInstance.isSetAccessorDeclaration(member) ||
        tsInstance.isSemicolonClassElement(member) ||
        hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)
}

function memberNameForDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.ClassElement
): string {
    const name = member.name

    if (name === undefined) {
        return "constructor"
    }

    if (tsInstance.isPrivateIdentifier(name)) {
        return name.text
    }

    if (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name) || tsInstance.isNumericLiteral(name)) {
        return name.text
    }

    return name.getText(sourceFile)
}

function parameterNameForDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    parameter: ts.ParameterDeclaration
): string {
    if (tsInstance.isIdentifier(parameter.name)) {
        return parameter.name.text
    }

    return parameter.name.getText(sourceFile)
}

// ---------------------------------------------------------------------------
// Mixin class transformation
//
// A mixin class expands into three declarations:
//
//     interface X<T> { ...instance member signatures... }
//     const __X$mixin = <T>(base: AnyConstructor) => class extends base { ...body... }
//     const X = __X$mixin(Object) as unknown as
//         (new <T>(...args: any[]) => X<T>) & ClassStatics<ReturnType<typeof __X$mixin>>

function expandMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef,
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory         = tsInstance.factory
    const declaration     = ref.declaration

    if (declaration === undefined) {
        throw new Error(`Mixin class ${ref.className} has no declaration in the transformed file`)
    }

    const defaultExport = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    const exportModifiers = exportModifiersOf(tsInstance, declaration)
    const factoryExportModifiers = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword)
        ? [ factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ]
        : undefined
    const typeParameters  = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const requiredBase    = requiredBaseType(tsInstance, declaration)
    const diagnostics     = collectMixinClassDiagnostics(tsInstance, sourceFile, declaration)
    const diagnosticAliases = createMixinDeclarationDiagnosticAliases(
        tsInstance,
        ref.className,
        diagnostics,
        declaration
    )

    if (options.sourceView) {
        return [
            ...diagnosticAliases,
            ...expandSourceViewMixinClass(tsInstance, sourceFile, declaration, context)
        ]
    }

    const interfaceMembers = buildInterfaceMembers(tsInstance, sourceFile, declaration)

    const interfaceDeclaration = preserveTextRange(tsInstance, factory.createInterfaceDeclaration(
        exportModifiers,
        ref.className,
        typeParameters,
        interfaceHeritageClauses(tsInstance, declaration),
        interfaceMembers
    ), interfaceDeclarationRange(declaration, interfaceMembers))

    const factoryStatement = preserveTextRange(tsInstance, factory.createVariableStatement(
        factoryExportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                ref.localFactoryName,
                undefined,
                undefined,
                createMixinFactoryExpression(tsInstance, declaration, typeParameters, context)
            )
        ], tsInstance.NodeFlags.Const)
    ), generatedTextRange(sourceFile, declaration.end))

    const valueStatement = preserveTextRange(tsInstance, factory.createVariableStatement(
        exportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                ref.className,
                undefined,
                undefined,
                factory.createAsExpression(
                    factory.createAsExpression(
                        factory.createCallExpression(
                            factory.createIdentifier(defineMixinClassName),
                            undefined,
                            [
                                factory.createStringLiteral(ref.className),
                                asMixinFactory(tsInstance, factory.createIdentifier(ref.localFactoryName)),
                                factory.createArrayLiteralExpression(
                                    directDependencyRefs(tsInstance, declaration, context).map((dependencyRef) => {
                                        return mixinValueIdentifier(tsInstance, dependencyRef)
                                    })
                                ),
                                ...(requiredBase === undefined
                                    ? []
                                    : [ cloneNode(tsInstance, requiredBase.expression) ])
                            ]
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    factory.createIntersectionTypeNode([
                        factory.createParenthesizedType(factory.createConstructorTypeNode(
                            undefined,
                            typeParameters,
                            [ factory.createParameterDeclaration(
                                undefined,
                                factory.createToken(tsInstance.SyntaxKind.DotDotDotToken),
                                "args",
                                undefined,
                                factory.createArrayTypeNode(factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword))
                            ) ],
                            factory.createTypeReferenceNode(
                                ref.className,
                                typeParameters?.map((typeParameter) => {
                                    return factory.createTypeReferenceNode(typeParameter.name, undefined)
                                })
                            )
                        )),
                        factory.createTypeReferenceNode(classStaticsName, [
                            factory.createTypeReferenceNode("ReturnType", [
                                factory.createTypeQueryNode(factory.createIdentifier(ref.localFactoryName))
                            ])
                        ]),
                        createRuntimeMixinClassType(tsInstance, declaration)
                    ])
                )
            )
        ], tsInstance.NodeFlags.Const)
    ), generatedTextRange(sourceFile, declaration.end))

    const defaultExportStatement = defaultExport
        ? [ preserveTextRange(tsInstance, factory.createExportAssignment(
            undefined,
            undefined,
            factory.createIdentifier(ref.className)
        ), generatedTextRange(sourceFile, declaration.end)) ]
        : []

    return [ interfaceDeclaration, ...diagnosticAliases, factoryStatement, valueStatement, ...defaultExportStatement ]
}

function createMixinDeclarationDiagnosticAliases(
    tsInstance: TypeScript,
    className: string,
    diagnostics: MixinDeclarationDiagnostic[],
    original: ts.ClassDeclaration
): ts.TypeAliasDeclaration[] {
    const factory = tsInstance.factory

    return diagnostics.map((diagnostic, index) => {
        return preserveGeneratedDeclarationRange(tsInstance, factory.createTypeAliasDeclaration(
            undefined,
            generatedName(className, `$mixinDeclarationError${index}`),
            [ factory.createTypeParameterDeclaration(
                undefined,
                "__mixinDeclarationError",
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                factory.createLiteralTypeNode(factory.createStringLiteral(diagnostic.message))
            ) ],
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        ), diagnostic.node, original)
    })
}

function expandSourceViewMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin class must have a name")
    }

    const requiredBase = requiredBaseType(tsInstance, declaration)
    const dependencyHeritage = implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            context.byLocalName.has(heritageType.expression.text)
    })
    const generatedHeritageRange = generatedTextRange(
        sourceFile,
        declaration.heritageClauses?.pos ?? declaration.typeParameters?.end ?? declaration.name.end
    )

    if (dependencyHeritage.length === 0 && requiredBase === undefined) {
        const metadataExtendsClause = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            preserveTextRange(tsInstance, createSourceViewMixinMetadataBase(tsInstance, declaration, undefined, []), generatedHeritageRange)
        ]), generatedHeritageRange)

        return [ factory.updateClassDeclaration(
            declaration,
            declaration.modifiers,
            declaration.name,
            declaration.typeParameters,
            preserveTextRange(
                tsInstance,
                factory.createNodeArray([ metadataExtendsClause, ...(declaration.heritageClauses ?? []) ]),
                declaration.heritageClauses ?? generatedHeritageRange
            ),
            declaration.members
        ) ]
    }

    const baseName       = generatedName(declaration.name.text, consumerBaseSuffix)
    const cloneTypeParameters = () => declaration.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter))
    const dependencyRefs = dependencyHeritage.map((heritageType) => {
        return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
    })

    const baseInterface = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        cloneTypeParameters(),
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
                ...dependencyHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ]
        ) ],
        []
    ), declaration)

    const baseClass = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        cloneTypeParameters(),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            createSourceViewMixinMetadataBase(tsInstance, declaration, requiredBase, dependencyRefs)
        ]) ],
        []
    ), declaration)

    const updatedDeclaration = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(tsInstance, declaration, baseName, generatedHeritageRange),
        declaration.members
    )

    return [ baseInterface, baseClass, updatedDeclaration ]
}

// Source-view mixin class base: a cast that adds RuntimeMixinClass metadata
// (factory/requirements/base symbols) and required-base/dependency statics, so
// typeof MixinClass matches the runtime value.
function createSourceViewMixinMetadataBase(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    requiredBase: ts.ExpressionWithTypeArguments | undefined,
    dependencyRefs: ResolvedMixinRef[]
): ts.ExpressionWithTypeArguments {
    const factory = tsInstance.factory

    const headType = requiredBase === undefined
        ? factory.createTypeReferenceNode(anyConstructorName, undefined)
        : createSourceViewConsumerBaseHeadType(tsInstance, requiredBase, undefined, undefined)
    const castType = factory.createIntersectionTypeNode([
        headType,
        ...dependencyRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                return factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(factory.createIdentifier(ref.localValueName as string))
                ])
            }),
        createRuntimeMixinClassType(tsInstance, declaration)
    ])

    return factory.createExpressionWithTypeArguments(
        factory.createParenthesizedExpression(
            factory.createAsExpression(
                factory.createAsExpression(
                    requiredBase === undefined
                        ? factory.createIdentifier("Object")
                        : cloneNode(tsInstance, requiredBase.expression),
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                ),
                castType
            )
        ),
        undefined
    )
}

function createMixinFactoryExpression(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    context: FileMixinContext
): ts.FunctionExpression {
    const factory = tsInstance.factory

    return factory.createFunctionExpression(
        undefined,
        undefined,
        undefined,
        typeParameters,
        [ createBaseParameter(tsInstance, declaration, context) ],
        undefined,
        factory.createBlock([
            factory.createReturnStatement(factory.createClassExpression(
                undefined,
                undefined,
                undefined,
                [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
                    factory.createExpressionWithTypeArguments(factory.createIdentifier("base"), undefined)
                ]) ],
                mixinRuntimeMembers(tsInstance, declaration)
            ))
        ], true)
    )
}

function mixinRuntimeMembers(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.NodeArray<ts.ClassElement> {
    return tsInstance.factory.createNodeArray(declaration.members.filter((member) => {
        if (tsInstance.isConstructorDeclaration(member) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            return false
        }

        return isSupportedMixinClassMember(tsInstance, member)
    }))
}

function asMixinFactory(tsInstance: TypeScript, expression: ts.Expression): ts.Expression {
    return tsInstance.factory.createAsExpression(
        tsInstance.factory.createAsExpression(
            expression,
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
        ),
        tsInstance.factory.createTypeReferenceNode(mixinFactoryName, undefined)
    )
}

function directDependencyRefs(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ResolvedMixinRef[] {
    return implementsTypes(tsInstance, declaration)
        .filter((heritageType) => {
            return tsInstance.isIdentifier(heritageType.expression) &&
                context.byLocalName.has(heritageType.expression.text)
        })
        .map((heritageType) => {
            return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
        })
}

function mixinValueIdentifier(tsInstance: TypeScript, ref: ResolvedMixinRef): ts.Identifier {
    if (ref.localValueName === undefined) {
        throw new Error(`Mixin value ${ref.className} is not available in the transformed file`)
    }

    return tsInstance.factory.createIdentifier(ref.localValueName)
}

function createRuntimeMixinClassType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeReferenceNode {
    const requiredBase = requiredBaseType(tsInstance, declaration)

    return tsInstance.factory.createTypeReferenceNode(
        runtimeMixinClassName,
        requiredBase === undefined
            ? undefined
            : [ heritageTypeToTypeReference(tsInstance, requiredBase) ]
    )
}

// Factory base parameter: AnyConstructor, or AnyConstructor<Dep1<...> & Dep2<...>>
// for a mixin with dependencies. This gives the body typed super access.
function createBaseParameter(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ParameterDeclaration {
    const factory = tsInstance.factory

    const dependencyTypes = [
        ...(requiredBaseType(tsInstance, declaration) === undefined
            ? []
            : [ heritageTypeToTypeReference(tsInstance, requiredBaseType(tsInstance, declaration)!) ]),
        ...implementsTypes(tsInstance, declaration)
            .filter((heritageType) => {
                return tsInstance.isIdentifier(heritageType.expression) &&
                    context.byLocalName.has(heritageType.expression.text)
            })
            .map((heritageType) => heritageTypeToTypeReference(tsInstance, heritageType))
    ]

    const baseInstanceType =
        dependencyTypes.length === 0 ? undefined :
        dependencyTypes.length === 1 ? dependencyTypes[0] :
            factory.createIntersectionTypeNode(dependencyTypes)

    return factory.createParameterDeclaration(
        undefined,
        undefined,
        "base",
        undefined,
        factory.createTypeReferenceNode(
            anyConstructorName,
            baseInstanceType === undefined ? undefined : [ baseInstanceType ]
        )
    )
}

// ---------------------------------------------------------------------------
// Consumer class transformation
//
// A consumer expands into an intermediate base with declaration merging:
//
//     interface __X$base<A> extends Mixin1<...>, Mixin2<...> {}
//     class __X$base<A> extends (mixinChain(Base, Mixin1, Mixin2) as unknown as
//         typeof Base & ClassStatics<typeof Mixin1> & ClassStatics<typeof Mixin2>) {}
//     class X<A> extends __X$base<A> implements Mixin1<...>, Mixin2<...> { ...body unchanged... }

function consumedMixins(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            context.byLocalName.has(heritageType.expression.text)
    })
}

function expandConsumerClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name           = declaration.name.text
    const baseName       = generatedName(name, consumerBaseSuffix)
    const extendsType    = extendsClause(tsInstance, declaration)?.types[0]

    const mixinHeritage = consumedMixins(tsInstance, declaration, context)
    const directMixinRefs = mixinHeritage.map((heritageType) => {
        return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
    })
    let linearized: ResolvedMixinRef[]

    try {
        linearized = linearizeDependencies(
            directMixinRefs.map((ref) => ref.key),
            context
        )
    } catch (error) {
        if (error instanceof DependencyLinearizationError) {
            return expandConsumerClassWithLinearizationDiagnostic(
                tsInstance,
                sourceFile,
                declaration,
                context,
                directMixinRefs,
                error
            )
        }

        throw error
    }
    const generatedRange = options.sourceView ? declaration : generatedTextRange(sourceFile, declaration.pos)
    const sourceViewGeneratedRange = generatedTextRange(sourceFile, declaration.pos)
    const originalExtendsClause = extendsClause(tsInstance, declaration)
    const firstHeritageType = declaration.heritageClauses?.[0]?.types[0]
    const generatedHeritageRange = originalExtendsClause ??
        (options.sourceView && declaration.heritageClauses !== undefined
            ? { pos : declaration.heritageClauses.pos, end : declaration.heritageClauses.end }
            : generatedTextRange(
                sourceFile,
                declaration.heritageClauses?.pos ?? declaration.name.end
            ))
    const generatedHeritageTypeRange = extendsType ??
        (options.sourceView && firstHeritageType !== undefined ? firstHeritageType : generatedHeritageRange)

    if (extendsType !== undefined && !isSupportedBaseExpression(tsInstance, extendsType.expression)) {
        return expandConsumerClassWithUnsupportedBaseDiagnostic(
            tsInstance,
            sourceFile,
            declaration,
            context,
            directMixinRefs,
            linearized,
            options,
            generatedRange,
            generatedHeritageRange,
            generatedHeritageTypeRange
        )
    }

    const implicitRequiredBase = extendsType === undefined
        ? firstRequiredBaseType(tsInstance, context, linearized)
        : undefined
    const emptyBaseName = extendsType === undefined && implicitRequiredBase === undefined
        ? generatedName(name, consumerEmptyBaseSuffix)
        : undefined
    const requiredBaseValidations = extendsType === undefined
        ? []
        : createRequiredBaseValidations(
            tsInstance,
            context,
            sourceFile,
            declaration,
            extendsType,
            linearized,
            generatedHeritageTypeRange,
            options
        )
    const missingRuntimeImportValidations = createMissingRuntimeImportValidations(
        tsInstance,
        declaration,
        directMixinRefs,
        mixinHeritage
    )
    const staticCollisionValidations = createStaticCollisionValidations(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        emptyBaseName,
        linearized,
        generatedHeritageTypeRange,
        options.staticCollisionCheck,
        options.sourceView
    )
    const consumerValidations = [
        ...requiredBaseValidations,
        ...missingRuntimeImportValidations,
        ...staticCollisionValidations
    ]
    // Each generated declaration gets its own type parameter clones: reusing one
    // node in two declarations breaks name resolution in tsserver because the
    // binder reassigns the node parent to the last declaration.
    const checkedTypeParameters = () => options.sourceView
        ? appendSourceViewValidationTypeParameters(tsInstance, declaration.typeParameters, consumerValidations)
        : appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            consumerValidations
        )

    const baseInterfaceNode = factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters(),
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                // In source view, even a base without type arguments goes into
                // interface extends so cloned heritage types map to originals 1:1.
                ...(extendsType !== undefined && (options.sourceView || extendsType.typeArguments !== undefined)
                    ? [ cloneExpressionWithTypeArguments(tsInstance, extendsType) ]
                    : []),
                ...(implicitRequiredBase === undefined
                    ? []
                    : [ cloneExpressionWithTypeArguments(tsInstance, implicitRequiredBase) ]),
                ...mixinHeritage.map((heritageType) => {
                    return cloneExpressionWithTypeArguments(tsInstance, heritageType)
                })
            ]
        ) ],
        []
    )
    const baseInterface = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseInterfaceNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseInterfaceNode, generatedRange, declaration)

    const baseClassNode = factory.createClassDeclaration(
        undefined,
        baseName,
        checkedTypeParameters(),
        [ consumerBaseClassHeritage(
            tsInstance,
            extendsType,
            implicitRequiredBase,
            emptyBaseName,
            directMixinRefs,
            linearized,
            options
        ) ],
        []
    )
    const baseClass = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseClassNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseClassNode, generatedRange, declaration)

    const constructionMembers = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        linearized,
        context,
        options,
        options.sourceView ? generatedTextRange(sourceFile, declaration.members.end) : generatedRange
    )
    const updatedConsumerMembers = constructionMembers.length === 0
        ? declaration.members
        : factory.createNodeArray([ ...declaration.members, ...constructionMembers ])
    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            baseName,
            generatedHeritageRange,
            generatedHeritageTypeRange,
            consumerValidations.map((validation) => validation.typeArgument),
            !options.sourceView || originalExtendsClause !== undefined
        ),
        updatedConsumerMembers
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ options.sourceView
            ? preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                sourceViewGeneratedRange,
                declaration
            )
            : preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                generatedRange,
                declaration
            ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
}

function expandConsumerClassWithUnsupportedBaseDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions,
    generatedRange: ts.TextRange,
    generatedHeritageRange: ts.TextRange,
    generatedHeritageTypeRange: ts.TextRange
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name          = declaration.name.text
    const baseName      = generatedName(name, consumerBaseSuffix)
    const extendsType   = extendsClause(tsInstance, declaration)?.types[0]
    const mixinHeritage = consumedMixins(tsInstance, declaration, context)

    if (extendsType === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "Unsupported base diagnostic requires an extends clause")
    }

    const diagnosticValidation = createConsumerDiagnosticValidation(
        tsInstance,
        declaration,
        "__mixinUnsupportedBaseExpression",
        unsupportedBaseDiagnosticMessage(tsInstance, sourceFile, declaration, extendsType),
        generatedHeritageTypeRange
    )
    const checkedTypeParameters = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        [ diagnosticValidation ]
    )

    const baseInterface = preserveGeneratedDeclarationRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            mixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
        ) ],
        []
    ), generatedRange, declaration)

    const baseClass = preserveGeneratedDeclarationRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            [ diagnosticValidation ]
        ),
        [ unsupportedBaseConsumerHeritage(
            tsInstance,
            extendsType,
            directMixinRefs,
            linearizedMixinRefs,
            options
        ) ],
        []
    ), generatedRange, declaration)

    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            baseName,
            generatedHeritageRange,
            generatedHeritageTypeRange,
            [ diagnosticValidation.typeArgument ]
        ),
        declaration.members
    )

    return [ baseInterface, baseClass, updatedConsumer ]
}

function expandConsumerClassWithLinearizationDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    directMixinRefs: ResolvedMixinRef[],
    error: DependencyLinearizationError
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name           = declaration.name.text
    const baseName       = generatedName(name, consumerBaseSuffix)
    const extendsType    = extendsClause(tsInstance, declaration)?.types[0]
    const emptyBaseName  = extendsType === undefined ? generatedName(name, consumerEmptyBaseSuffix) : undefined
    const mixinHeritage  = consumedMixins(tsInstance, declaration, context)
    const generatedRange = generatedTextRange(sourceFile, declaration.pos)
    const originalExtendsClause = extendsClause(tsInstance, declaration)
    const generatedHeritageRange = originalExtendsClause ?? generatedTextRange(
        sourceFile,
        declaration.heritageClauses?.pos ?? declaration.name.end
    )
    const generatedHeritageTypeRange = extendsType ?? generatedHeritageRange
    const diagnosticValidation = createLinearizationDiagnosticValidation(
        tsInstance,
        declaration,
        linearizationDiagnosticMessage(directMixinRefs, context, error),
        generatedHeritageTypeRange
    )
    const checkedTypeParameters = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        [ diagnosticValidation ]
    )

    const baseInterface = preserveGeneratedDeclarationRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(extendsType?.typeArguments !== undefined ? [ cloneExpressionWithTypeArguments(tsInstance, extendsType) ] : []),
                ...mixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ]
        ) ],
        []
    ), generatedRange, declaration)

    const baseClass = preserveGeneratedDeclarationRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            [ diagnosticValidation ]
        ),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            cloneExpressionWithTypeArguments(
                tsInstance,
                consumerRuntimeBaseType(tsInstance, extendsType, undefined, emptyBaseName)
            )
        ]) ],
        []
    ), generatedRange, declaration)

    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            baseName,
            generatedHeritageRange,
            generatedHeritageTypeRange,
            [ diagnosticValidation.typeArgument ]
        ),
        declaration.members
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ preserveGeneratedDeclarationRange(
            tsInstance,
            factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
            generatedRange,
            declaration
        ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
}

function createConstructionMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    context: FileMixinContext,
    options: TransformOptions,
    generatedRange: ts.TextRange
): ts.ClassElement[] {
    if (declaration.name === undefined ||
        hasStaticMemberNamed(tsInstance, declaration, "new") ||
        !isConstructionBaseOptIn(tsInstance, sourceFile, extendsType ?? implicitRequiredBase, options)
    ) {
        return []
    }

    const factory = tsInstance.factory
    const staticModifier = [ factory.createToken(tsInstance.SyntaxKind.StaticKeyword) ]
    const configType = createConstructionConfigType(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        mixinRefs,
        options.constructionConfig
    )
    const consumerType = createConsumerInstanceType(tsInstance, declaration)

    // The checker validates overload adjacency by position (subsequent.pos ===
    // node.end), so source-view overloads get consecutive non-zero-width ranges:
    // zero width makes a node "missing" for the checker.
    const overloadRange = (index: number): ts.TextRange => options.sourceView
        ? { pos : generatedRange.pos + index, end : generatedRange.pos + index + 1 }
        : generatedRange

    return [
        preserveGeneratedDeclarationRange(tsInstance, factory.createMethodDeclaration(
            staticModifier,
            undefined,
            "new",
            undefined,
            declaration.typeParameters === undefined
                ? undefined
                : factory.createNodeArray(declaration.typeParameters.map((typeParameter) => deepCloneNode(tsInstance, typeParameter))),
            [ factory.createParameterDeclaration(
                undefined,
                undefined,
                "props",
                factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                configType
            ) ],
            consumerType,
            undefined
        ), overloadRange(0), declaration),
        preserveGeneratedDeclarationRange(tsInstance, factory.createMethodDeclaration(
            staticModifier,
            undefined,
            "new",
            undefined,
            [ factory.createTypeParameterDeclaration(
                undefined,
                "T",
                factory.createTypeReferenceNode(anyConstructorName, [
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                ]),
                undefined
            ) ],
            [
                factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "this",
                    undefined,
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
                ),
                factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "props",
                    factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                )
            ],
            factory.createTypeReferenceNode("InstanceType", [
                factory.createTypeReferenceNode("T", undefined)
            ]),
            undefined
        ), overloadRange(1), declaration),
        preserveGeneratedDeclarationRange(tsInstance, factory.createMethodDeclaration(
            staticModifier,
            undefined,
            "new",
            undefined,
            undefined,
            [ factory.createParameterDeclaration(
                undefined,
                undefined,
                "props",
                factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            ) ],
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword),
            factory.createBlock([
                factory.createReturnStatement(factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                        factory.createSuper(),
                        "new"
                    ),
                    undefined,
                    [ factory.createIdentifier("props") ]
                ))
            ], true)
        ), overloadRange(2), declaration)
    ]
}

function isConstructionBaseOptIn(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions,
    seen = new Set<string>()
): boolean {
    if (baseType === undefined) {
        return false
    }

    if (isPackageBaseExpression(tsInstance, sourceFile, baseType.expression, options)) {
        return true
    }

    if (!tsInstance.isIdentifier(baseType.expression)) {
        return false
    }

    const baseName = baseType.expression.text

    if (seen.has(baseName)) {
        return false
    }

    seen.add(baseName)

    const baseDeclaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === baseName
    })
    const nextBase = baseDeclaration === undefined ? undefined : extendsClause(tsInstance, baseDeclaration)?.types[0]

    return isConstructionBaseOptIn(tsInstance, sourceFile, nextBase, options, seen)
}

function isPackageBaseExpression(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    expression: ts.Expression,
    options: TransformOptions
): boolean {
    for (const statement of sourceFile.statements) {
        if (!isPackageImport(tsInstance, statement, options)) {
            continue
        }

        const importClause = (statement as ts.ImportDeclaration).importClause
        const namedBindings = importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings) &&
            tsInstance.isPropertyAccessExpression(expression) &&
            tsInstance.isIdentifier(expression.expression) &&
            expression.expression.text === namedBindings.name.text &&
            expression.name.text === "Base"
        ) {
            return true
        }

        if (!tsInstance.isNamedImports(namedBindings) || !tsInstance.isIdentifier(expression)) {
            continue
        }

        if (namedBindings.elements.some((element) => {
            return (element.propertyName?.text ?? element.name.text) === "Base" &&
                element.name.text === expression.text
        })) {
            return true
        }
    }

    return false
}

function hasStaticMemberNamed(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    name: string
): boolean {
    return declaration.members.some((member) => {
        return hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
            isNamedClassElement(member) &&
            propertyNameText(tsInstance, member.name) === name
    })
}

function createConstructionConfigType(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    mode: ConstructionConfigMode
): ts.TypeNode {
    const factory = tsInstance.factory

    if (mode === "instance-type") {
        return factory.createTypeReferenceNode("Partial", [
            createConsumerInstanceType(tsInstance, declaration)
        ])
    }

    const properties = staticConstructionConfigProperties(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        mixinRefs
    )
    const requiredNames = properties
        .filter((property) => !property.optional)
        .map((property) => property.name)
    const optionalNames = properties
        .filter((property) => property.optional)
        .map((property) => property.name)
    const consumerType = createConsumerInstanceType(tsInstance, declaration)
    const requiredType = requiredNames.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Pick", [
            consumerType,
            literalKeyUnionType(tsInstance, requiredNames)
        ])
    const optionalType = optionalNames.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Partial", [
            factory.createTypeReferenceNode("Pick", [
                createConsumerInstanceType(tsInstance, declaration),
                literalKeyUnionType(tsInstance, optionalNames)
            ])
        ])

    if (requiredType === undefined && optionalType === undefined) {
        return factory.createTypeReferenceNode("Partial", [
            factory.createTypeReferenceNode("Pick", [
                consumerType,
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
            ])
        ])
    }

    if (requiredType === undefined) {
        return optionalType as ts.TypeNode
    }

    if (optionalType === undefined) {
        return requiredType
    }

    return factory.createIntersectionTypeNode([
        requiredType,
        optionalType
    ])
}

function staticConstructionConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[]
): ConfigProperty[] {
    return uniqueConfigProperties([
        ...baseConfigProperties(tsInstance, sourceFile, extendsType ?? implicitRequiredBase),
        ...mixinRefs.flatMap((ref) => ref.configProperties),
        ...instanceConfigProperties(tsInstance, declaration, true)
    ])
}

function literalKeyUnionType(
    tsInstance: TypeScript,
    names: string[]
): ts.TypeNode {
    const factory = tsInstance.factory

    return names.length === 1
        ? factory.createLiteralTypeNode(factory.createStringLiteral(names[0]))
        : factory.createUnionTypeNode(names.map((name) => {
            return factory.createLiteralTypeNode(factory.createStringLiteral(name))
        }))
}

function baseConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined
): ConfigProperty[] {
    if (baseType === undefined || !tsInstance.isIdentifier(baseType.expression)) {
        return []
    }

    const baseName = baseType.expression.text
    const baseDeclaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === baseName
    })

    return baseDeclaration === undefined ? [] : instanceConfigProperties(tsInstance, baseDeclaration, true)
}

function createConsumerInstanceType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeReferenceNode {
    if (declaration.name === undefined) {
        throw new MixinTransformError(declaration.getSourceFile(), declaration, "A mixin consumer class must have a name")
    }

    return tsInstance.factory.createTypeReferenceNode(
        declaration.name.text,
        declaration.typeParameters?.map((typeParameter) => {
            return tsInstance.factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
    )
}

function createLinearizationDiagnosticValidation(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    message: string,
    generatedRange: ts.TextRange
): RequiredBaseValidation {
    return createConsumerDiagnosticValidation(
        tsInstance,
        declaration,
        "__mixinLinearizationError",
        message,
        generatedRange
    )
}

function createConsumerDiagnosticValidation(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    parameterBaseName: string,
    message: string,
    generatedRange: ts.TextRange
): RequiredBaseValidation {
    const factory = tsInstance.factory

    return {
        typeParameter : preserveTextRange(tsInstance, factory.createTypeParameterDeclaration(
            undefined,
            uniqueGeneratedTypeParameterName(declaration, parameterBaseName),
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            undefined
        ), generatedRange),
        typeArgument : preserveTextRange(
            tsInstance,
            factory.createLiteralTypeNode(factory.createStringLiteral(message)),
            generatedRange
        )
    }
}

function unsupportedBaseDiagnosticMessage(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const actualBase = heritageTypeText(tsInstance, sourceFile, extendsType)

    return "Unsupported mixin consumer base expression. " +
        `${consumerName} extends ${actualBase}. ` +
        "Only named base classes such as Base or ns.Base are supported for now. " +
        "Fix: assign the expression to a named class or const and extend that name."
}

function linearizationDiagnosticMessage(
    directMixinRefs: ResolvedMixinRef[],
    context: FileMixinContext,
    error: DependencyLinearizationError
): string {
    const directMixins = directMixinRefs.map((ref) => ref.className).join(", ")
    const pending = error.pendingSequences
        .map((sequence) => {
            return sequence.map((key) => context.byKey.get(key)?.className ?? key).join(" -> ")
        })
        .join("; ")

    return "Cannot linearize mixin classes with the C3 algorithm. " +
        `Requested mixins: ${directMixins || "<none>"}. ` +
        `Conflicting order requirements: ${pending || "<unknown>"}. ` +
        "This means the mixins require incompatible inheritance order, for example A before B and B before A. " +
        "Fix it by changing the implements order, removing one conflicting mixin, or splitting the incompatible mixins."
}

function createMixinChainExpression(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[],
    baseExpression: ts.Expression
): ts.Expression {
    const factory = tsInstance.factory

    return factory.createCallExpression(
        factory.createIdentifier(mixinChainName),
        undefined,
        [
            baseExpression,
            ...mixinRefs.map((ref) => mixinValueIdentifier(tsInstance, ref))
        ]
    )
}

function unsupportedBaseConsumerHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions
): ts.HeritageClause {
    const factory = tsInstance.factory

    if (options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            cloneExpressionWithTypeArguments(tsInstance, extendsType)
        ])
    }

    return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
            factory.createParenthesizedExpression(
                factory.createAsExpression(
                    factory.createAsExpression(
                        createMixinChainExpression(
                            tsInstance,
                            directMixinRefs,
                            cloneNode(tsInstance, extendsType.expression)
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    createUnsupportedBaseConsumerCastType(tsInstance, linearizedMixinRefs)
                )
            ),
            undefined
        )
    ])
}

function consumerBaseClassHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions
): ts.HeritageClause {
    const factory = tsInstance.factory

    if (options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            factory.createExpressionWithTypeArguments(
                factory.createParenthesizedExpression(
                    factory.createAsExpression(
                        factory.createAsExpression(
                            cloneNode(
                                tsInstance,
                                consumerRuntimeBaseType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName)
                                    .expression
                            ),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                        ),
                        createSourceViewConsumerBaseCastType(
                            tsInstance,
                            options.packageName,
                            extendsType,
                            implicitRequiredBase,
                            emptyBaseName,
                            linearizedMixinRefs
                        )
                    )
                ),
                undefined
            )
        ])
    }

    return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
            factory.createParenthesizedExpression(
                factory.createAsExpression(
                    factory.createAsExpression(
                        createMixinChainExpression(
                            tsInstance,
                            directMixinRefs,
                            cloneNode(
                                tsInstance,
                                consumerRuntimeBaseType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName)
                                    .expression
                            )
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    createConsumerBaseCastType(
                        tsInstance,
                        extendsType,
                        implicitRequiredBase,
                        emptyBaseName,
                        linearizedMixinRefs
                    )
                )
            ),
            undefined
        )
    ])
}

function consumerRuntimeBaseType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): ts.ExpressionWithTypeArguments {
    if (extendsType !== undefined) {
        return extendsType
    }

    if (implicitRequiredBase !== undefined) {
        return implicitRequiredBase
    }

    if (emptyBaseName === undefined) {
        return tsInstance.factory.createExpressionWithTypeArguments(
            tsInstance.factory.createIdentifier("Object"),
            undefined
        )
    }

    return tsInstance.factory.createExpressionWithTypeArguments(
        tsInstance.factory.createIdentifier(emptyBaseName as string),
        undefined
    )
}

function cloneExpressionWithTypeArguments(
    tsInstance: TypeScript,
    expression: ts.ExpressionWithTypeArguments
): ts.ExpressionWithTypeArguments {
    return tsInstance.factory.createExpressionWithTypeArguments(
        deepCloneNode(tsInstance, expression.expression),
        expression.typeArguments?.map((typeArgument) => deepCloneNode(tsInstance, typeArgument))
    )
}

function firstRequiredBaseType(
    tsInstance: TypeScript,
    context: FileMixinContext,
    mixinRefs: ResolvedMixinRef[]
): ts.ExpressionWithTypeArguments | undefined {
    for (const ref of mixinRefs) {
        if (ref.declaration === undefined) {
            if (ref.requiredBase === undefined) {
                continue
            }

            if (ref.requiredBase.import !== undefined) {
                context.usedFactoryImports.set(
                    `${ref.requiredBase.import.specifier}:${ref.requiredBase.import.localName}`,
                    ref.requiredBase.import
                )
            }

            return tsInstance.factory.createExpressionWithTypeArguments(
                tsInstance.factory.createIdentifier(ref.requiredBase.localName),
                undefined
            )
        }

        const requiredBase = requiredBaseType(tsInstance, ref.declaration)

        if (requiredBase !== undefined) {
            return requiredBase
        }
    }

    return undefined
}

function createRequiredBaseValidations(
    tsInstance: TypeScript,
    context: FileMixinContext,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRefs: ResolvedMixinRef[],
    generatedRange: ts.TextRange,
    options: TransformOptions
): RequiredBaseValidation[] {
    const validations: RequiredBaseValidation[] = []

    for (const ref of mixinRefs) {
        if (options.sourceView && ref.declaration === undefined && ref.requiredBase === undefined) {
            continue
        }

        const requiredBase = requiredBaseRequirementOfMixinRef(tsInstance, context, sourceFile, ref)

        if (requiredBase === undefined) {
            continue
        }

        if (options.sourceView && baseSatisfiesRequiredBaseSyntactically(
            tsInstance,
            sourceFile,
            extendsType,
            requiredBase.typeNode
        )) {
            continue
        }

        const typeParameter = preserveTextRange(tsInstance, tsInstance.factory.createTypeParameterDeclaration(
            undefined,
            uniqueGeneratedTypeParameterName(declaration, `__mixinRequiredBase${validations.length}`),
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            undefined
        ), generatedRange)

        validations.push({
            typeParameter,
            typeArgument : preserveTextRange(
                tsInstance,
                options.sourceView
                    ? createDiagnosticLiteralType(tsInstance, requiredBaseDiagnosticMessage(
                        tsInstance,
                        sourceFile,
                        declaration,
                        extendsType,
                        ref,
                        requiredBase
                    ))
                    : createRequiredBaseDiagnosticType(
                        tsInstance,
                        sourceFile,
                        declaration,
                        extendsType,
                        ref,
                        requiredBase
                    ),
                generatedRange
            )
        })
    }

    return validations
}

function createMissingRuntimeImportValidations(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinRefs: ResolvedMixinRef[],
    mixinHeritage: ts.ExpressionWithTypeArguments[]
): RequiredBaseValidation[] {
    const validations: RequiredBaseValidation[] = []

    for (let index = 0; index < mixinRefs.length; index++) {
        const ref = mixinRefs[index]

        if (ref.missingRuntimeImport === undefined) {
            continue
        }

        const heritageType = mixinHeritage[index]
        const range = heritageType ?? declaration

        validations.push(createConsumerDiagnosticValidation(
            tsInstance,
            declaration,
            `__mixinMissingRuntimeValue${validations.length}`,
            missingRuntimeImportDiagnosticMessage(declaration, ref),
            range
        ))
    }

    return validations
}

function missingRuntimeImportDiagnosticMessage(
    declaration: ts.ClassDeclaration,
    mixinRef: ResolvedMixinRef
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const missingImport = mixinRef.missingRuntimeImport

    if (missingImport === undefined) {
        throw new Error("Missing runtime import diagnostic requires missing runtime metadata")
    }

    return "Missing mixin runtime value. " +
        `Consumer ${consumerName} implements ${mixinRef.className}, and ${mixinRef.className} is marked as a runtime mixin class in declarations from "${missingImport.specifier}". ` +
        "However, the transformer could not find a JavaScript runtime module for that declaration file. " +
        "Mixin classes must be available as runtime values so mixinChain(...) can apply them. " +
        `Fix: publish the JavaScript export for ${mixinRef.className}, expose it from "${missingImport.specifier}", ` +
        `import ${mixinRef.className} as a value, or remove ${mixinRef.className} from the implements list.`
}

function createStaticCollisionValidations(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[],
    generatedRange: ts.TextRange,
    mode: StaticCollisionCheckMode,
    sourceView = false
): RequiredBaseValidation[] {
    if (mode === false) {
        return []
    }

    const sources = [
        ...consumerBaseStaticSources(tsInstance, sourceFile, extendsType, implicitRequiredBase, emptyBaseName),
        ...mixinRefs.flatMap((ref) => {
            return mixinStaticSource(tsInstance, ref)
        })
    ]
    const validations: RequiredBaseValidation[] = []

    for (let leftIndex = 0; leftIndex < sources.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex++) {
            const left = sources[leftIndex]
            const right = sources[rightIndex]
            const knownOverlap = knownStaticNameOverlap(left, right)

            if (sourceView && knownOverlap === undefined) {
                continue
            }

            if (knownOverlap !== undefined && knownOverlap.length === 0) {
                continue
            }

            validations.push({
                typeParameter : preserveTextRange(tsInstance, tsInstance.factory.createTypeParameterDeclaration(
                    undefined,
                    uniqueGeneratedTypeParameterName(declaration, `__mixinStaticCollision${validations.length}`),
                    tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                    undefined
                ), generatedRange),
                typeArgument : preserveTextRange(
                    tsInstance,
                    sourceView && knownOverlap !== undefined
                        ? createDiagnosticLiteralType(tsInstance, staticCollisionDiagnosticMessage(
                            declaration,
                            left,
                            right,
                            knownOverlap
                        ))
                        : createStaticCollisionDiagnosticType(
                            tsInstance,
                            declaration,
                            left,
                            right,
                            knownOverlap,
                            mode
                        ),
                    generatedRange
                )
            })
        }
    }

    return validations
}

function consumerBaseStaticSources(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): StaticSource[] {
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        if (emptyBaseName === undefined) {
            return []
        }

        return [ {
            name        : emptyBaseName,
            typeNode    : tsInstance.factory.createTypeQueryNode(tsInstance.factory.createIdentifier(emptyBaseName)),
            staticNames : new Set()
        } ]
    }

    return [ {
        name        : heritageTypeText(tsInstance, sourceFile, baseType),
        typeNode    : tsInstance.factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression)),
        staticNames : staticNamesOfBaseExpression(tsInstance, sourceFile, baseType.expression)
    } ]
}

function mixinStaticSource(
    tsInstance: TypeScript,
    ref: ResolvedMixinRef
): StaticSource[] {
    if (ref.localValueName === undefined) {
        return []
    }

    return [ {
        name        : ref.className,
        typeNode    : tsInstance.factory.createTypeQueryNode(tsInstance.factory.createIdentifier(ref.localValueName)),
        staticNames : ref.declaration === undefined ? undefined : staticMemberNames(tsInstance, ref.declaration)
    } ]
}

function staticNamesOfBaseExpression(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    expression: ts.Expression
): Set<string> | undefined {
    if (!tsInstance.isIdentifier(expression)) {
        return undefined
    }

    const declaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === expression.text
    })

    return declaration === undefined ? undefined : staticMemberNames(tsInstance, declaration)
}

function staticMemberNames(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): Set<string> {
    const names = new Set<string>()

    for (const member of declaration.members) {
        if (!hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) || !isNamedClassElement(member)) {
            continue
        }

        if (tsInstance.isIdentifier(member.name) ||
            tsInstance.isStringLiteral(member.name) ||
            tsInstance.isNumericLiteral(member.name)
        ) {
            names.add(member.name.text)
        }
    }

    return names
}

function knownStaticNameOverlap(
    left: StaticSource,
    right: StaticSource
): string[] | undefined {
    if (left.staticNames === undefined || right.staticNames === undefined) {
        return undefined
    }

    return [ ...left.staticNames ].filter((name) => right.staticNames?.has(name) === true)
}

function createStaticCollisionDiagnosticType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    left: StaticSource,
    right: StaticSource,
    knownOverlap: string[] | undefined,
    mode: Exclude<StaticCollisionCheckMode, false>
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createConditionalTypeNode(
        factory.createTupleTypeNode([
            factory.createTypeReferenceNode(staticConflictKeysName(mode), [
                cloneNode(tsInstance, left.typeNode),
                cloneNode(tsInstance, right.typeNode)
            ])
        ]),
        factory.createTupleTypeNode([
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        ]),
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
        factory.createLiteralTypeNode(factory.createStringLiteral(
            staticCollisionDiagnosticMessage(declaration, left, right, knownOverlap)
        ))
    )
}

function createDiagnosticLiteralType(
    tsInstance: TypeScript,
    message: string
): ts.LiteralTypeNode {
    return tsInstance.factory.createLiteralTypeNode(tsInstance.factory.createStringLiteral(message))
}

function staticConflictKeysName(mode: Exclude<StaticCollisionCheckMode, false>): string {
    return mode === "strict" ? staticStrictConflictKeysName : staticNeverConflictKeysName
}

function staticCollisionDiagnosticMessage(
    declaration: ts.ClassDeclaration,
    left: StaticSource,
    right: StaticSource,
    knownOverlap: string[] | undefined
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const names = knownOverlap === undefined || knownOverlap.length === 0
        ? "one or more static members"
        : knownOverlap.join(", ")

    return "Static mixin member collision. " +
        `Consumer ${consumerName} combines ${left.name} and ${right.name}, which both declare incompatible static member(s): ${names}. ` +
        "Runtime inheritance can only keep one implementation for a static name, so this would make the generated class misleadingly typed. " +
        "Fix: rename one static member, make the static member types compatible, or remove one mixin from the implements list."
}

function appendRequiredBaseValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    const typeParameters = [
        ...(consumerTypeParameters?.map((typeParameter) => cloneNode(tsInstance, typeParameter)) ?? []),
        ...validations.map((validation) => cloneNode(tsInstance, validation.typeParameter))
    ]

    return typeParameters.length === 0 ? undefined : tsInstance.factory.createNodeArray(typeParameters)
}

function appendSourceViewValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    const typeParameters = [
        ...(consumerTypeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)) ?? []),
        ...validations.map((validation) => deepCloneNode(tsInstance, validation.typeParameter))
    ]

    return typeParameters.length === 0 ? undefined : tsInstance.factory.createNodeArray(typeParameters)
}

function uniqueGeneratedTypeParameterName(
    declaration: ts.ClassDeclaration,
    baseName: string
): string {
    const existing = new Set(declaration.typeParameters?.map((typeParameter) => typeParameter.name.text) ?? [])
    let name = baseName
    let index = 0

    while (existing.has(name)) {
        index++
        name = `${baseName}_${index}`
    }

    return name
}

function requiredBaseRequirementOfMixinRef(
    tsInstance: TypeScript,
    context: FileMixinContext,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef
): RequiredBaseRequirement | undefined {
    if (ref.declaration !== undefined) {
        const requiredBase = requiredBaseType(tsInstance, ref.declaration)

        return requiredBase === undefined ? undefined : {
            typeNode : heritageTypeToTypeReference(tsInstance, requiredBase),
            name     : heritageTypeText(tsInstance, sourceFile, requiredBase)
        }
    }

    if (ref.requiredBase !== undefined) {
        if (ref.requiredBase.import !== undefined) {
            context.usedFactoryImports.set(
                `${ref.requiredBase.import.specifier}:${ref.requiredBase.import.localName}`,
                ref.requiredBase.import
            )
        }

        return {
            typeNode : tsInstance.factory.createTypeReferenceNode(ref.requiredBase.localName, undefined),
            name     : ref.requiredBase.import?.importedName ?? ref.requiredBase.localName
        }
    }

    if (ref.localValueName === undefined) {
        return undefined
    }

    return {
        typeNode : runtimeMixinClassRequiredBaseInstanceType(tsInstance, ref.localValueName),
        name     : `${ref.className} required base`
    }
}

function baseSatisfiesRequiredBaseSyntactically(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    actualBase: ts.ExpressionWithTypeArguments,
    requiredBase: ts.TypeNode,
    seen = new Set<string>()
): boolean {
    const requiredBaseName = typeReferenceNameText(tsInstance, requiredBase)

    if (requiredBaseName === undefined || !tsInstance.isIdentifier(actualBase.expression)) {
        return false
    }

    const actualBaseName = actualBase.expression.text

    if (actualBaseName === requiredBaseName) {
        return true
    }

    if (seen.has(actualBaseName)) {
        return false
    }

    seen.add(actualBaseName)

    const actualBaseDeclaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === actualBaseName
    })
    const nextBase = actualBaseDeclaration === undefined
        ? undefined
        : extendsClause(tsInstance, actualBaseDeclaration)?.types[0]

    return nextBase === undefined
        ? false
        : baseSatisfiesRequiredBaseSyntactically(tsInstance, sourceFile, nextBase, requiredBase, seen)
}

function typeReferenceNameText(tsInstance: TypeScript, typeNode: ts.TypeNode): string | undefined {
    if (!tsInstance.isTypeReferenceNode(typeNode)) {
        return undefined
    }

    return entityNameText(tsInstance, typeNode.typeName)
}

function entityNameText(tsInstance: TypeScript, name: ts.EntityName): string {
    if (tsInstance.isIdentifier(name)) {
        return name.text
    }

    return `${entityNameText(tsInstance, name.left)}.${name.right.text}`
}

function createRequiredBaseDiagnosticType(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRef: ResolvedMixinRef,
    requiredBase: RequiredBaseRequirement
): ts.TypeNode {
    const factory = tsInstance.factory
    const actualBase = heritageTypeToTypeReference(tsInstance, extendsType)

    return factory.createConditionalTypeNode(
        actualBase,
        cloneNode(tsInstance, requiredBase.typeNode),
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
        factory.createLiteralTypeNode(factory.createStringLiteral(
            requiredBaseDiagnosticMessage(tsInstance, sourceFile, declaration, extendsType, mixinRef, requiredBase)
        ))
    )
}

function requiredBaseDiagnosticMessage(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRef: ResolvedMixinRef,
    requiredBase: RequiredBaseRequirement
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const actualBase = heritageTypeText(tsInstance, sourceFile, extendsType)

    return "Mixin required base mismatch. " +
        `Mixin ${mixinRef.className} can only be applied to ${requiredBase.name} or a subclass of ${requiredBase.name}, ` +
        `but ${consumerName} extends ${actualBase}. ` +
        `This requirement comes from ${mixinRef.className} declaring extends ${requiredBase.name}; for mixin classes, ` +
        "extends means a required consumer base, not a fixed runtime base. " +
        `Fix: make ${consumerName} extend ${requiredBase.name} or one of its subclasses, choose a compatible base class, ` +
        `or remove ${mixinRef.className} from the implements list.`
}

function heritageTypeText(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    heritageType: ts.ExpressionWithTypeArguments
): string {
    if (heritageType.pos >= 0 && heritageType.end >= 0) {
        return heritageType.getText(sourceFile)
    }

    if (tsInstance.isIdentifier(heritageType.expression) || tsInstance.isPropertyAccessExpression(heritageType.expression)) {
        const typeArguments = heritageType.typeArguments === undefined || heritageType.typeArguments.length === 0
            ? ""
            : "<...>"

        return `${heritageType.expression.getText(sourceFile)}${typeArguments}`
    }

    return "<base class>"
}

function runtimeMixinClassRequiredBaseInstanceType(
    tsInstance: TypeScript,
    valueName: string
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode("InstanceType", [
        factory.createIndexedAccessTypeNode(
            factory.createTypeQueryNode(factory.createIdentifier(valueName)),
            factory.createTypeQueryNode(factory.createIdentifier(metadataBaseLocalName))
        )
    ])
}

// Runtime-chain cast: typeof Base (or typeof __X without an explicit base)
// plus statics for each applied mixin whose value is available in the file.
function createConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const factory = tsInstance.factory

    const types = [
        createConsumerBaseHeadType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName),
        ...mixinRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                return factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(factory.createIdentifier(ref.localValueName as string))
                ])
            })
    ]

    return types.length === 1 ? types[0] : factory.createIntersectionTypeNode(types)
}

function createSourceViewConsumerBaseCastType(
    tsInstance: TypeScript,
    _packageName: string,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const factory = tsInstance.factory

    const types = [
        createSourceViewConsumerBaseHeadType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName),
        ...mixinRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                return factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(factory.createIdentifier(ref.localValueName as string))
                ])
            })
    ]

    return types.length === 1 ? types[0] : factory.createIntersectionTypeNode(types)
}

function createUnsupportedBaseConsumerCastType(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const factory = tsInstance.factory
    const types = [
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        ...mixinRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                return factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(factory.createIdentifier(ref.localValueName as string))
                ])
            })
    ]

    return types.length === 1 ? types[0] : factory.createIntersectionTypeNode(types)
}

function createConsumerBaseHeadType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): ts.TypeNode {
    const factory = tsInstance.factory
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        return factory.createTypeQueryNode(factory.createIdentifier(emptyBaseName as string))
    }

    if (baseType.typeArguments === undefined) {
        return factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        factory.createTypeReferenceNode(classStaticsName, [
            factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
        ])
    ])
}

function createSourceViewConsumerBaseHeadType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): ts.TypeNode {
    const factory = tsInstance.factory
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        return factory.createTypeQueryNode(factory.createIdentifier(emptyBaseName as string))
    }

    if (baseType.typeArguments === undefined) {
        return factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        factory.createTypeReferenceNode(classStaticsName, [
            factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
        ])
    ])
}

function isSupportedBaseExpression(tsInstance: TypeScript, expression: ts.Expression): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return true
    }

    return tsInstance.isPropertyAccessExpression(expression) &&
        tsInstance.isIdentifier(expression.name) &&
        isSupportedBaseExpression(tsInstance, expression.expression)
}

function consumerHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    baseName: string,
    generatedRange: ts.TextRange,
    generatedTypeRange: ts.TextRange = generatedRange,
    extraTypeArguments: ts.TypeNode[] = [],
    keepImplements = true
): ts.NodeArray<ts.HeritageClause> {
    const factory = tsInstance.factory

    const ownTypeArguments = declaration.typeParameters !== undefined && declaration.typeParameters.length > 0
        ? declaration.typeParameters.map((typeParameter): ts.TypeNode => {
            return factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
        : []
    const typeArguments = ownTypeArguments.length > 0 || extraTypeArguments.length > 0
        ? [ ...ownTypeArguments, ...extraTypeArguments ]
        : undefined

    const extendsType = preserveTextRange(tsInstance, factory.createExpressionWithTypeArguments(
        factory.createIdentifier(baseName),
        typeArguments
    ), generatedTypeRange)

    if (tsInstance.isExpressionWithTypeArguments(generatedTypeRange as ts.Node)) {
        const originalGeneratedTypeRange = generatedTypeRange as ts.ExpressionWithTypeArguments

        preserveTextRange(tsInstance, extendsType.expression, originalGeneratedTypeRange.expression)

        if (extendsType.typeArguments !== undefined) {
            const generatedTypeArgumentRange = zeroWidthRange(originalGeneratedTypeRange.expression.end)

            preserveTextRange(
                tsInstance,
                extendsType.typeArguments,
                originalGeneratedTypeRange.typeArguments ?? generatedTypeArgumentRange
            )

            extendsType.typeArguments.forEach((typeArgument, index) => {
                const originalTypeArgument = originalGeneratedTypeRange.typeArguments?.[index]

                if (originalTypeArgument !== undefined) {
                    preserveSubtreeTextRange(
                        tsInstance,
                        typeArgument,
                        originalTypeArgument
                    )
                }
            })
        }
    }

    const extendsHeritage = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        extendsType
    ]), generatedRange)

    preserveTextRange(tsInstance, extendsHeritage.types, generatedTypeRange)

    const implementsHeritage = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })
    const clauses = keepImplements && implementsHeritage !== undefined
        ? [ extendsHeritage, implementsHeritage ]
        : [ extendsHeritage ]
    const heritageRange = keepImplements ? declaration.heritageClauses ?? generatedRange : generatedRange

    return preserveTextRange(tsInstance, factory.createNodeArray(clauses), heritageRange)
}

function expressionToEntityName(tsInstance: TypeScript, expression: ts.Expression): ts.EntityName {
    if (tsInstance.isIdentifier(expression)) {
        return tsInstance.factory.createIdentifier(expression.text)
    }

    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        return tsInstance.factory.createQualifiedName(
            expressionToEntityName(tsInstance, expression.expression),
            expression.name.text
        )
    }

    throw new Error("Unsupported base class expression of a mixin consumer")
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

function interfaceHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause[] | undefined {
    const requiredBase = requiredBaseType(tsInstance, declaration)
    const types = [
        ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
        ...implementsTypes(tsInstance, declaration)
    ]

    if (types.length === 0) {
        return undefined
    }

    return [ tsInstance.factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, types) ]
}

function heritageTypeToTypeReference(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode(
        expressionToEntityName(tsInstance, heritageType.expression),
        heritageType.typeArguments
    )
}

function exportModifiersOf(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.Modifier[] | undefined {
    if (!hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword) ||
        hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    ) {
        return undefined
    }

    return [ tsInstance.factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ]
}

class MixinTransformError extends Error {
    constructor (sourceFile: ts.SourceFile, node: ts.Node | ts.PropertyName, message: string) {
        const position = nodePosition(sourceFile, node)

        super(`${sourceFile.fileName}${position}: ${message}`)
    }
}

function nodePosition(sourceFile: ts.SourceFile, node: ts.Node): string {
    const start = node.getStart?.(sourceFile)

    if (start === undefined || start < 0) {
        return ""
    }

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)

    return `(${line + 1},${character + 1})`
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

function shouldSkipFileName(fileName: string): boolean {
    const normalizedFileName = normalizePath(fileName)

    return normalizedFileName.includes("/node_modules/") ||
        normalizedFileName.endsWith(".d.ts") ||
        !/\.[cm]?tsx?$/.test(normalizedFileName)
}
