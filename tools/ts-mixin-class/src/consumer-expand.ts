import type * as ts from "typescript"
import { rewritePublicOnlyUndefinedInitializers } from "./construction-initializers.js"
import { isPackageImport } from "./decorators.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createSourceViewConsumerBaseHeadType,
    heritageTypeToTypeReference,
    MixinTransformError,
    mixinValueIdentifier
} from "./expand-util.js"
import { linearizeDependencies } from "./linearization.js"
import {
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    consumerEmptyBaseSuffix,
    defaultTransformOptions,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    implementsTypes,
    instanceConfigProperties,
    isNamedClassElement,
    metadataBaseLocalName,
    mixinChainName,
    propertyNameText,
    requiredBaseType,
    staticNeverConflictKeysName,
    staticStrictConflictKeysName,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionConfigMode,
    type FileMixinContext,
    type RequiredBaseRequirement,
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type StaticCollisionCheckMode,
    type StaticSource,
    type TransformOptions
} from "./model.js"
import {
    cloneNode,
    deepCloneNode,
    generatedTextRange,
    hasModifier,
    preserveGeneratedDeclarationRange,
    preserveSourceViewGeneratedClassLikeRange,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export function consumedMixins(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            context.byLocalName.has(heritageType.expression.text)
    })
}

export function expandConsumerClass(
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
    const consumerMembersWithSuper = addSyntheticSuperCallToConstructors(
        tsInstance,
        sourceFile,
        declaration.members,
        originalExtendsClause === undefined
    )
    const consumerMembers = isConstructionBaseOptIn(
        tsInstance,
        sourceFile,
        extendsType ?? implicitRequiredBase,
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

export function isConstructionBaseOptIn(
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
        if (!isPackageBaseImport(tsInstance, statement, options)) {
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

function isPackageBaseImport(
    tsInstance: TypeScript,
    statement: ts.Statement,
    options: TransformOptions
): boolean {
    return isPackageImport(tsInstance, statement, options) ||
        tsInstance.isImportDeclaration(statement) &&
        tsInstance.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === `${options.packageName}/base`
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

function isSupportedBaseExpression(tsInstance: TypeScript, expression: ts.Expression): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return true
    }

    return tsInstance.isPropertyAccessExpression(expression) &&
        tsInstance.isIdentifier(expression.name) &&
        isSupportedBaseExpression(tsInstance, expression.expression)
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
