import type * as ts from "typescript"
import {
    appendRequiredBaseValidationTypeParameters,
    appendSourceViewValidationTypeParameters,
    createConsumerDiagnosticValidation,
    createLinearizationDiagnosticValidation,
    createMissingRuntimeImportValidations,
    createRequiredBaseValidations,
    linearizationDiagnosticMessage,
    unsupportedBaseDiagnosticMessage
} from "./consumer-diagnostics.js"
import { rewritePublicOnlyUndefinedInitializers } from "./construction-initializers.js"
import {
    createConstructionMembers,
    isConstructionBaseOptIn
} from "./construction-config.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createSourceViewConsumerBaseHeadType,
    expressionToEntityName,
    MixinTransformError,
    mixinValueIdentifier
} from "./expand-util.js"
import { linearizeDependencies } from "./linearization.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { createStaticCollisionValidations } from "./static-collisions.js"
import {
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    consumerEmptyBaseSuffix,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    mixinChainName,
    requiredBaseType,
    type FileMixinContext,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    cloneNode,
    generatedTextRange,
    preserveGeneratedDeclarationRange,
    preserveSourceViewGeneratedClassLikeRange,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

type ConsumerExpansionContext = {
    name                       : string,
    baseName                   : string,
    extendsType                : ts.ExpressionWithTypeArguments | undefined,
    directMixinRefs            : ResolvedMixinRef[],
    generatedRange             : ts.TextRange,
    sourceViewGeneratedRange   : ts.TextRange,
    originalExtendsClause      : ts.HeritageClause | undefined,
    generatedHeritageRange     : ts.TextRange,
    generatedHeritageTypeRange : ts.TextRange
}

export function expandConsumerClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions,
    mixinHeritage = localMixinHeritageTypes(tsInstance, declaration, context)
): ts.Statement[] {
    const factory = tsInstance.factory
    const expansion = createConsumerExpansionContext(
        tsInstance,
        sourceFile,
        declaration,
        context,
        options,
        mixinHeritage
    )
    let linearized: ResolvedMixinRef[]

    try {
        linearized = linearizeDependencies(
            expansion.directMixinRefs.map((ref) => ref.key),
            context
        )
    } catch (error) {
        if (error instanceof DependencyLinearizationError) {
            return expandConsumerClassWithLinearizationDiagnostic(
                tsInstance,
                sourceFile,
                declaration,
                context,
                expansion.directMixinRefs,
                error
            )
        }

        throw error
    }

    if (expansion.extendsType !== undefined && !isSupportedBaseExpression(tsInstance, expansion.extendsType.expression)) {
        return expandConsumerClassWithUnsupportedBaseDiagnostic(
            tsInstance,
            sourceFile,
            declaration,
            context,
            expansion.directMixinRefs,
            linearized,
            options,
            expansion.generatedRange,
            expansion.generatedHeritageRange,
            expansion.generatedHeritageTypeRange
        )
    }

    const implicitRequiredBase = expansion.extendsType === undefined
        ? firstRequiredBaseType(tsInstance, context, linearized)
        : undefined
    const emptyBaseName = expansion.extendsType === undefined && implicitRequiredBase === undefined
        ? generatedName(expansion.name, consumerEmptyBaseSuffix)
        : undefined
    const requiredBaseValidations = expansion.extendsType === undefined
        ? []
        : createRequiredBaseValidations(
            tsInstance,
            context,
            sourceFile,
            declaration,
            expansion.extendsType,
            linearized,
            expansion.generatedHeritageTypeRange,
            options
        )
    const missingRuntimeImportValidations = createMissingRuntimeImportValidations(
        tsInstance,
        declaration,
        expansion.directMixinRefs,
        mixinHeritage
    )
    const staticCollisionValidations = createStaticCollisionValidations(
        tsInstance,
        sourceFile,
        declaration,
        expansion.extendsType,
        implicitRequiredBase,
        emptyBaseName,
        linearized,
        expansion.generatedHeritageTypeRange,
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
        expansion.baseName,
        checkedTypeParameters(),
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                // In source view, even a base without type arguments goes into
                // interface extends so cloned heritage types map to originals 1:1.
                ...(expansion.extendsType !== undefined && (options.sourceView || expansion.extendsType.typeArguments !== undefined)
                    ? [ cloneExpressionWithTypeArguments(tsInstance, expansion.extendsType) ]
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
        : preserveGeneratedDeclarationRange(tsInstance, baseInterfaceNode, expansion.generatedRange, declaration)

    const baseClassNode = factory.createClassDeclaration(
        undefined,
        expansion.baseName,
        checkedTypeParameters(),
        [ consumerBaseClassHeritage(
            tsInstance,
            expansion.extendsType,
            implicitRequiredBase,
            emptyBaseName,
            expansion.directMixinRefs,
            linearized,
            options
        ) ],
        []
    )
    const baseClass = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseClassNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseClassNode, expansion.generatedRange, declaration)

    const constructionMembers = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        expansion.extendsType,
        implicitRequiredBase,
        linearized,
        options,
        options.sourceView ? generatedTextRange(sourceFile, declaration.members.end) : expansion.generatedRange
    )
    const consumerMembersWithSuper = addSyntheticSuperCallToConstructors(
        tsInstance,
        sourceFile,
        declaration.members,
        expansion.originalExtendsClause === undefined
    )
    const consumerMembers = isConstructionBaseOptIn(
        tsInstance,
        sourceFile,
        expansion.extendsType ?? implicitRequiredBase,
        options
    )
        ? rewritePublicOnlyUndefinedInitializers(tsInstance, consumerMembersWithSuper, options)
        : consumerMembersWithSuper
    const updatedConsumerMembers = constructionMembers.length === 0
        ? consumerMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...consumerMembers, ...constructionMembers ]), consumerMembers)
    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            expansion.baseName,
            expansion.generatedHeritageRange,
            expansion.generatedHeritageTypeRange,
            consumerValidations.map((validation) => validation.typeArgument),
            !options.sourceView || expansion.originalExtendsClause !== undefined
        ),
        updatedConsumerMembers
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ options.sourceView
            ? preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                expansion.sourceViewGeneratedRange,
                declaration
            )
            : preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                expansion.generatedRange,
                declaration
            ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
}

function createConsumerExpansionContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions,
    mixinHeritage: ts.ExpressionWithTypeArguments[]
): ConsumerExpansionContext {
    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name = declaration.name.text
    const originalExtendsClause = extendsClause(tsInstance, declaration)
    const extendsType = originalExtendsClause?.types[0]
    const generatedRange = options.sourceView ? declaration : generatedTextRange(sourceFile, declaration.pos)
    const sourceViewGeneratedRange = generatedTextRange(sourceFile, declaration.pos)
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

    return {
        name,
        baseName : generatedName(name, consumerBaseSuffix),
        extendsType,
        directMixinRefs : localMixinRefs(context, mixinHeritage),
        generatedRange,
        sourceViewGeneratedRange,
        originalExtendsClause,
        generatedHeritageRange,
        generatedHeritageTypeRange
    }
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
    const mixinHeritage = localMixinHeritageTypes(tsInstance, declaration, context)

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
        addSyntheticSuperCallToConstructors(
            tsInstance,
            sourceFile,
            declaration.members,
            extendsType === undefined
        )
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
    const mixinHeritage  = localMixinHeritageTypes(tsInstance, declaration, context)
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
        addSyntheticSuperCallToConstructors(
            tsInstance,
            sourceFile,
            declaration.members,
            extendsType === undefined
        )
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

function addSyntheticSuperCallToConstructors(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    members: ts.NodeArray<ts.ClassElement>,
    shouldAdd: boolean
): ts.NodeArray<ts.ClassElement> {
    if (!shouldAdd) {
        return members
    }

    let changed = false
    const updatedMembers = members.map((member) => {
        if (!tsInstance.isConstructorDeclaration(member) ||
            member.body === undefined ||
            constructorHasSuperCall(tsInstance, member)
        ) {
            return member
        }

        changed = true

        return tsInstance.factory.updateConstructorDeclaration(
            member,
            member.modifiers,
            member.parameters,
            tsInstance.factory.updateBlock(member.body, [
                syntheticSuperCall(tsInstance, sourceFile, member),
                ...member.body.statements
            ])
        )
    })

    return changed
        ? preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(updatedMembers), members)
        : members
}

function constructorHasSuperCall(
    tsInstance: TypeScript,
    declaration: ts.ConstructorDeclaration
): boolean {
    return declaration.body?.statements.some((statement) => {
        return tsInstance.isExpressionStatement(statement) &&
            tsInstance.isCallExpression(statement.expression) &&
            statement.expression.expression.kind === tsInstance.SyntaxKind.SuperKeyword
    }) ?? false
}

function syntheticSuperCall(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ConstructorDeclaration
): ts.Statement {
    return preserveTextRange(
        tsInstance,
        tsInstance.factory.createExpressionStatement(tsInstance.factory.createCallExpression(
            tsInstance.factory.createSuper(),
            undefined,
            []
        )),
        generatedTextRange(sourceFile, declaration.body?.statements.pos ?? declaration.pos)
    )
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

function isSupportedBaseExpression(tsInstance: TypeScript, expression: ts.Expression): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return true
    }

    return tsInstance.isPropertyAccessExpression(expression) &&
        tsInstance.isIdentifier(expression.name) &&
        isSupportedBaseExpression(tsInstance, expression.expression)
}
