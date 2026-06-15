import type * as ts from "typescript"
import { buildInterfaceMembers, interfaceDeclarationRange } from "./interface-members.js"
import {
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    defineMixinClassName,
    generatedName,
    implementsTypes,
    isNamedClassElement,
    mixinFactoryName,
    requiredBaseType,
    runtimeMixinClassName,
    type FileMixinContext,
    type MixinDeclarationDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createSourceViewConsumerBaseHeadType,
    heritageTypeToTypeReference,
    MixinTransformError
} from "./expand-util.js"
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

export function expandMixinClass(
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
