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

type MixinClassInfo = {
    declaration  : ts.ClassDeclaration,
    name         : string,
    // имена mixin-классов этого же файла из implements, в порядке объявления
    dependencies : string[]
}

const defaultTransformOptions: TransformOptions = {
    packageName   : "ts-mixin-class",
    decoratorName : "mixin"
}

const anyConstructorName = "AnyConstructor"
const classStaticsName   = "ClassStatics"
const mixinFactorySuffix = "$mixin"
const consumerBaseSuffix = "$base"

// ---------------------------------------------------------------------------
// Runtime/типовая поверхность пакета, используемая сгенерированным кодом

export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

export type ClassStatics<C> = Omit<C, "prototype">

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

// ---------------------------------------------------------------------------
// ts-patch ProgramTransformer

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

// ---------------------------------------------------------------------------
// Трансформация исходного файла

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

    const mixinClasses = collectMixinClasses(tsInstance, sourceFile, mixinDecoratorImports, resolvedOptions)

    if (mixinClasses.size === 0) {
        return sourceFile
    }

    const statements: ts.Statement[] = []

    let helperImportInserted = false

    for (const statement of sourceFile.statements) {
        statements.push(statement)

        if (!helperImportInserted && isPackageImport(tsInstance, statement, resolvedOptions)) {
            statements.push(createHelperTypeImport(tsInstance, resolvedOptions))
            helperImportInserted = true
        }
    }

    const expandedStatements = statements.flatMap((statement) => {
        if (tsInstance.isClassDeclaration(statement) && statement.name !== undefined) {
            const info = mixinClasses.get(statement.name.text)

            if (info !== undefined && info.declaration === statement) {
                return expandMixinClass(tsInstance, sourceFile, info, mixinClasses)
            }

            if (consumedMixins(tsInstance, statement, mixinClasses).length > 0) {
                return expandConsumerClass(tsInstance, sourceFile, statement, mixinClasses)
            }
        }

        return [ statement ]
    })

    return tsInstance.factory.updateSourceFile(sourceFile, expandedStatements)
}

function collectMixinClasses(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions
): Map<string, MixinClassInfo> {
    const mixinClasses = new Map<string, MixinClassInfo>()

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isClassDeclaration(statement) ||
            !hasMixinDecorator(tsInstance, statement, imports, options)
        ) {
            continue
        }

        if (statement.name === undefined) {
            throw new MixinTransformError(sourceFile, statement, "A mixin class must have a name")
        }

        mixinClasses.set(statement.name.text, {
            declaration  : statement,
            name         : statement.name.text,
            dependencies : []
        })
    }

    for (const info of mixinClasses.values()) {
        validateMixinClass(tsInstance, sourceFile, info.declaration)

        for (const heritageType of implementsTypes(tsInstance, info.declaration)) {
            if (tsInstance.isIdentifier(heritageType.expression) &&
                mixinClasses.has(heritageType.expression.text)
            ) {
                info.dependencies.push(heritageType.expression.text)
            }
        }
    }

    return mixinClasses
}

function validateMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): void {
    if (extendsClause(tsInstance, declaration) !== undefined) {
        throw new MixinTransformError(
            sourceFile, declaration,
            "A mixin class cannot use `extends` - declare dependencies with `implements` instead"
        )
    }

    if (hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.AbstractKeyword)) {
        throw new MixinTransformError(sourceFile, declaration, "An `abstract` mixin class is not supported yet")
    }

    for (const member of declaration.members) {
        if (tsInstance.isConstructorDeclaration(member)) {
            throw new MixinTransformError(
                sourceFile, member,
                "A mixin class cannot declare a constructor - use field initializers instead"
            )
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword)
        ) {
            throw new MixinTransformError(
                sourceFile, member,
                "Mixin class members cannot be `private` or `protected`"
            )
        }

        if (isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)) {
            throw new MixinTransformError(
                sourceFile, member,
                "Mixin class members cannot use `#private` names"
            )
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword)) {
            throw new MixinTransformError(sourceFile, member, "`abstract` mixin class members are not supported yet")
        }
    }
}

// Mixin-класс разворачивается в три декларации (см. SPEC.md):
//
//     interface X<T> { ...сигнатуры инстанс-членов... }
//     const X$mixin = <T>(base: AnyConstructor) => class extends base { ...тело... }
//     const X = X$mixin(Object) as unknown as
//         (new <T>(...args: any[]) => X<T>) & ClassStatics<ReturnType<typeof X$mixin>>
function expandMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    info: MixinClassInfo,
    mixinClasses: Map<string, MixinClassInfo>
): ts.Statement[] {
    const factory        = tsInstance.factory
    const declaration    = info.declaration
    const exportModifiers = exportModifiersOf(tsInstance, declaration)
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined

    const interfaceDeclaration = factory.createInterfaceDeclaration(
        exportModifiers,
        info.name,
        typeParameters,
        interfaceHeritageClauses(tsInstance, declaration),
        buildInterfaceMembers(tsInstance, sourceFile, declaration)
    )

    const factoryStatement = factory.createVariableStatement(
        exportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                info.name + mixinFactorySuffix,
                undefined,
                undefined,
                factory.createArrowFunction(
                    undefined,
                    typeParameters,
                    [ createBaseParameter(tsInstance, declaration, mixinClasses) ],
                    undefined,
                    undefined,
                    factory.createClassExpression(
                        undefined,
                        undefined,
                        undefined,
                        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
                            factory.createExpressionWithTypeArguments(factory.createIdentifier("base"), undefined)
                        ]) ],
                        declaration.members
                    )
                )
            )
        ], tsInstance.NodeFlags.Const)
    )

    const valueStatement = factory.createVariableStatement(
        exportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                info.name,
                undefined,
                undefined,
                factory.createAsExpression(
                    factory.createAsExpression(
                        createMixinChainExpression(tsInstance, info, mixinClasses),
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
                                info.name,
                                typeParameters?.map((typeParameter) => {
                                    return factory.createTypeReferenceNode(typeParameter.name, undefined)
                                })
                            )
                        )),
                        factory.createTypeReferenceNode(classStaticsName, [
                            factory.createTypeReferenceNode("ReturnType", [
                                factory.createTypeQueryNode(factory.createIdentifier(info.name + mixinFactorySuffix))
                            ])
                        ])
                    ])
                )
            )
        ], tsInstance.NodeFlags.Const)
    )

    return [ interfaceDeclaration, factoryStatement, valueStatement ]
}

// Параметр base фабрики: AnyConstructor, либо AnyConstructor<Dep1<...> & Dep2<...>>
// для миксина с зависимостями - это даёт типизированный super внутри тела
function createBaseParameter(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinClasses: Map<string, MixinClassInfo>
): ts.ParameterDeclaration {
    const factory = tsInstance.factory

    const dependencyTypes = implementsTypes(tsInstance, declaration)
        .filter((heritageType) => {
            return tsInstance.isIdentifier(heritageType.expression) &&
                mixinClasses.has(heritageType.expression.text)
        })
        .map((heritageType) => heritageTypeToTypeReference(tsInstance, heritageType))

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

// Значение миксина: применение его фабрики к цепочке фабрик зависимостей
// поверх Object, в порядке DFS-линеаризации с дедупликацией
function createMixinChainExpression(
    tsInstance: TypeScript,
    info: MixinClassInfo,
    mixinClasses: Map<string, MixinClassInfo>
): ts.Expression {
    return createChainExpression(
        tsInstance,
        [ ...linearizeDependencies(info, mixinClasses), info.name ],
        tsInstance.factory.createIdentifier("Object")
    )
}

function createChainExpression(
    tsInstance: TypeScript,
    mixinNames: string[],
    baseExpression: ts.Expression
): ts.Expression {
    const factory = tsInstance.factory

    let expression = baseExpression

    for (const name of mixinNames) {
        expression = factory.createCallExpression(
            factory.createIdentifier(name + mixinFactorySuffix),
            undefined,
            [ expression ]
        )
    }

    return expression
}

// ---------------------------------------------------------------------------
// Трансформация класса-потребителя

function consumedMixins(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinClasses: Map<string, MixinClassInfo>
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            mixinClasses.has(heritageType.expression.text)
    })
}

// Потребитель разворачивается в промежуточную базу с declaration merging (SPEC.md):
//
//     interface X$base<A> extends Mixin1<...>, Mixin2<...> {}
//     class X$base<A> extends (Mixin2$mixin(Mixin1$mixin(Base)) as unknown as
//         typeof Base & ClassStatics<typeof Mixin1> & ClassStatics<typeof Mixin2>) {}
//     class X<A> extends X$base<A> implements Mixin1<...>, Mixin2<...> { ...тело без изменений... }
function expandConsumerClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    mixinClasses: Map<string, MixinClassInfo>
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name           = declaration.name.text
    const baseName       = name + consumerBaseSuffix
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const extendsType    = extendsClause(tsInstance, declaration)?.types[0]

    if (extendsType?.typeArguments !== undefined) {
        throw new MixinTransformError(
            sourceFile, extendsType,
            "A generic base class of a mixin consumer is not supported yet"
        )
    }

    const mixinHeritage = consumedMixins(tsInstance, declaration, mixinClasses)
    const linearized    = linearizeDependencies({
        declaration,
        name,
        dependencies : mixinHeritage.map((heritageType) => (heritageType.expression as ts.Identifier).text)
    }, mixinClasses)

    const baseInterface = factory.createInterfaceDeclaration(
        undefined,
        baseName,
        typeParameters,
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, mixinHeritage) ],
        []
    )

    const baseClass = factory.createClassDeclaration(
        undefined,
        baseName,
        typeParameters,
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            factory.createExpressionWithTypeArguments(
                factory.createParenthesizedExpression(
                    factory.createAsExpression(
                        factory.createAsExpression(
                            createChainExpression(
                                tsInstance,
                                linearized,
                                extendsType !== undefined
                                    ? extendsType.expression
                                    : factory.createIdentifier("Object")
                            ),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                        ),
                        createConsumerBaseCastType(tsInstance, extendsType, linearized)
                    )
                ),
                undefined
            )
        ]) ],
        []
    )

    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(tsInstance, declaration, baseName),
        declaration.members
    )

    return [ baseInterface, baseClass, updatedConsumer ]
}

// Каст runtime-цепочки: typeof Base (или AnyConstructor без явной базы)
// плюс статика каждого применённого миксина
function createConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    mixinNames: string[]
): ts.TypeNode {
    const factory = tsInstance.factory

    const types = [
        extendsType !== undefined
            ? factory.createTypeQueryNode(expressionToEntityName(tsInstance, extendsType.expression))
            : factory.createTypeReferenceNode(anyConstructorName, undefined),
        ...mixinNames.map((name) => {
            return factory.createTypeReferenceNode(classStaticsName, [
                factory.createTypeQueryNode(factory.createIdentifier(name))
            ])
        })
    ]

    return types.length === 1 ? types[0] : factory.createIntersectionTypeNode(types)
}

function consumerHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    baseName: string
): ts.HeritageClause[] {
    const factory = tsInstance.factory

    const typeArguments = declaration.typeParameters !== undefined && declaration.typeParameters.length > 0
        ? declaration.typeParameters.map((typeParameter) => {
            return factory.createTypeReferenceNode(typeParameter.name, undefined)
        })
        : undefined

    const extendsHeritage = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(factory.createIdentifier(baseName), typeArguments)
    ])

    const implementsHeritage = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })

    return implementsHeritage !== undefined ? [ extendsHeritage, implementsHeritage ] : [ extendsHeritage ]
}

function expressionToEntityName(tsInstance: TypeScript, expression: ts.Expression): ts.EntityName {
    if (tsInstance.isIdentifier(expression)) {
        return expression
    }

    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        return tsInstance.factory.createQualifiedName(
            expressionToEntityName(tsInstance, expression.expression),
            expression.name
        )
    }

    throw new Error("Unsupported base class expression of a mixin consumer")
}

function linearizeDependencies(
    info: MixinClassInfo,
    mixinClasses: Map<string, MixinClassInfo>,
    seen: Set<string> = new Set()
): string[] {
    const linearized: string[] = []

    for (const dependency of info.dependencies) {
        if (seen.has(dependency)) {
            continue
        }

        seen.add(dependency)

        const dependencyInfo = mixinClasses.get(dependency)

        if (dependencyInfo !== undefined) {
            linearized.push(...linearizeDependencies(dependencyInfo, mixinClasses, seen), dependency)
        }
    }

    return linearized
}

// ---------------------------------------------------------------------------
// Сигнатуры инстанс-членов для сгенерированного интерфейса

function buildInterfaceMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): ts.TypeElement[] {
    const factory = tsInstance.factory
    const members: ts.TypeElement[] = []

    const getters = new Map<string, ts.GetAccessorDeclaration>()
    const setters = new Map<string, ts.SetAccessorDeclaration>()

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)) {
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member)) {
            getters.set(memberNameText(tsInstance, sourceFile, member), member)
        }

        if (tsInstance.isSetAccessorDeclaration(member)) {
            setters.set(memberNameText(tsInstance, sourceFile, member), member)
        }
    }

    const emittedAccessors = new Set<string>()

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            tsInstance.isSemicolonClassElement(member)
        ) {
            continue
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            if (member.type === undefined) {
                throw new MixinTransformError(
                    sourceFile, member,
                    "A mixin class property must have an explicit type annotation"
                )
            }

            members.push(factory.createPropertySignature(
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                    : undefined,
                member.name,
                member.questionToken,
                member.type
            ))
            continue
        }

        if (tsInstance.isMethodDeclaration(member)) {
            if (member.type === undefined) {
                throw new MixinTransformError(
                    sourceFile, member,
                    "A mixin class method must have an explicit return type annotation"
                )
            }

            members.push(factory.createMethodSignature(
                undefined,
                member.name,
                member.questionToken,
                member.typeParameters,
                member.parameters.map((parameter) => signatureParameter(tsInstance, sourceFile, parameter)),
                member.type
            ))
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const name = memberNameText(tsInstance, sourceFile, member)

            if (emittedAccessors.has(name)) {
                continue
            }

            emittedAccessors.add(name)

            members.push(accessorSignature(
                tsInstance, sourceFile, member.name, getters.get(name), setters.get(name)
            ))
            continue
        }

        throw new MixinTransformError(sourceFile, member, "Unsupported mixin class member")
    }

    return members
}

function accessorSignature(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    name: ts.PropertyName,
    getter: ts.GetAccessorDeclaration | undefined,
    setter: ts.SetAccessorDeclaration | undefined
): ts.PropertySignature {
    const factory = tsInstance.factory

    const type =
        getter?.type ??
        (setter !== undefined && setter.parameters.length > 0 ? setter.parameters[0].type : undefined)

    if (type === undefined) {
        throw new MixinTransformError(
            sourceFile, getter ?? setter ?? name,
            "A mixin class accessor must have an explicit type annotation"
        )
    }

    return factory.createPropertySignature(
        setter === undefined ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ] : undefined,
        name,
        undefined,
        type
    )
}

function signatureParameter(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    parameter: ts.ParameterDeclaration
): ts.ParameterDeclaration {
    if (parameter.type === undefined) {
        throw new MixinTransformError(
            sourceFile, parameter,
            "A mixin class method parameter must have an explicit type annotation"
        )
    }

    if (parameter.initializer === undefined) {
        return parameter
    }

    // у параметра с инициализатором в сигнатуре инициализатор заменяется опциональностью
    return tsInstance.factory.createParameterDeclaration(
        undefined,
        parameter.dotDotDotToken,
        parameter.name,
        tsInstance.factory.createToken(tsInstance.SyntaxKind.QuestionToken),
        parameter.type,
        undefined
    )
}

// ---------------------------------------------------------------------------
// Вспомогательные построители

function createHelperTypeImport(tsInstance: TypeScript, options: TransformOptions): ts.ImportDeclaration {
    const factory = tsInstance.factory

    return factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
            undefined,
            undefined,
            factory.createNamedImports([
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(anyConstructorName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(classStaticsName))
            ])
        ),
        factory.createStringLiteral(options.packageName)
    )
}

function interfaceHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause[] | undefined {
    const types = implementsTypes(tsInstance, declaration)

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

    if (tsInstance.isIdentifier(heritageType.expression)) {
        return factory.createTypeReferenceNode(heritageType.expression.text, heritageType.typeArguments)
    }

    throw new Error("Unsupported heritage type expression")
}

function implementsTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments[] {
    const clause = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })

    return clause === undefined ? [] : [ ...clause.types ]
}

function extendsClause(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause | undefined {
    return declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })
}

function exportModifiersOf(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.Modifier[] | undefined {
    if (!hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword)) {
        return undefined
    }

    if (hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)) {
        throw new Error("A `export default` mixin class is not supported")
    }

    return [ tsInstance.factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ]
}

function hasModifier(
    tsInstance: TypeScript,
    node: ts.Node,
    kind: ts.SyntaxKind
): boolean {
    return tsInstance.canHaveModifiers(node) &&
        (tsInstance.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
}

function isNamedClassElement(
    member: ts.ClassElement
): member is ts.ClassElement & { name: ts.PropertyName } {
    return member.name !== undefined
}

function memberNameText(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.ClassElement
): string {
    const name = member.name

    if (name !== undefined && (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name))) {
        return name.text
    }

    throw new MixinTransformError(sourceFile, member, "Unsupported mixin class member name")
}

function isPackageImport(
    tsInstance: TypeScript,
    statement: ts.Statement,
    options: TransformOptions
): boolean {
    return tsInstance.isImportDeclaration(statement) &&
        tsInstance.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === options.packageName
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

// ---------------------------------------------------------------------------
// Детект маркер-декоратора (import-aware)

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
        if (!isPackageImport(tsInstance, statement, options)) {
            continue
        }

        const namedBindings = (statement as ts.ImportDeclaration).importClause?.namedBindings

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
