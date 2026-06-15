import type * as ts from "typescript"
import { isPackageImport } from "./decorators.js"
import { MixinTransformError } from "./expand-util.js"
import {
    anyConstructorName,
    extendsClause,
    instanceConfigProperties,
    isNamedClassElement,
    propertyNameText,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionConfigMode,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    deepCloneNode,
    hasModifier,
    preserveGeneratedDeclarationRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export function createConstructionMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
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
