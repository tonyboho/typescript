import path from "node:path"
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

// ---------------------------------------------------------------------------
// Реестр mixin-классов программы (кросс-файловость)

export type RegisteredMixin = {
    fileName     : string,
    name         : string,
    // ключи реестра зависимостей (mixin-записи из implements)
    dependencies : string[]
}

export type MixinRegistry = Map<string, RegisteredMixin>

export type CrossFileContext = {
    registry : MixinRegistry,
    resolveModuleFileName : (specifier: string, containingFile: string) => string | undefined
}

// Ссылка на миксин с точки зрения трансформируемого файла
type ResolvedMixinRef = {
    key              : string,
    className        : string,
    // имя значения миксина в этом файле (same-file или импорт); undefined для
    // транзитивной зависимости, которую файл не импортирует
    localValueName   : string | undefined,
    localFactoryName : string,
    factoryImport    : { specifier: string, importedName: string } | undefined,
    dependencies     : string[],
    declaration      : ts.ClassDeclaration | undefined
}

type FileMixinContext = {
    byLocalName : Map<string, ResolvedMixinRef>,
    byKey       : Map<string, ResolvedMixinRef>,
    // фабрики, реально использованные в сгенерированных цепочках
    usedFactoryImports : Map<string, { specifier: string, importedName: string, localName: string }>
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
    const options         = resolveTransformOptions(config)

    const resolveModuleFileName = (specifier: string, containingFile: string): string | undefined => {
        return tsInstance.resolveModuleName(specifier, containingFile, compilerOptions, compilerHost)
            .resolvedModule?.resolvedFileName
    }

    const registry  = buildMixinRegistry(tsInstance, program, options, resolveModuleFileName)
    const crossFile = registry.size === 0 ? undefined : { registry, resolveModuleFileName }
    const nextHost  = createMixinClassCompilerHost(tsInstance, compilerHost, config, crossFile)

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
    config: MixinClassTransformerConfig,
    crossFile?: CrossFileContext
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

            const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options, crossFile)

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
// Построение реестра mixin-классов по всем файлам программы

export function buildMixinRegistry(
    tsInstance: TypeScript,
    program: ts.Program,
    options: Partial<TransformOptions> = {},
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined
): MixinRegistry {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    type Candidate = {
        sourceFile       : ts.SourceFile,
        declaration      : ts.ClassDeclaration,
        name             : string,
        implementsNames  : string[]
    }

    const candidates: Candidate[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (shouldSkipSourceFile(sourceFile) || !sourceFile.text.includes(resolvedOptions.packageName)) {
            continue
        }

        const imports = collectMixinDecoratorImports(tsInstance, sourceFile, resolvedOptions)

        if (imports.identifiers.size === 0 && imports.namespaces.size === 0) {
            continue
        }

        for (const statement of sourceFile.statements) {
            if (!tsInstance.isClassDeclaration(statement) ||
                statement.name === undefined ||
                !hasMixinDecorator(tsInstance, statement, imports, resolvedOptions)
            ) {
                continue
            }

            candidates.push({
                sourceFile,
                declaration     : statement,
                name            : statement.name.text,
                implementsNames : implementsTypes(tsInstance, statement)
                    .map((heritageType) => heritageType.expression)
                    .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
                    .map((expression) => expression.text)
            })
        }
    }

    const registry: MixinRegistry = new Map()

    for (const candidate of candidates) {
        registry.set(registryKey(candidate.sourceFile.fileName, candidate.name), {
            fileName     : candidate.sourceFile.fileName,
            name         : candidate.name,
            dependencies : []
        })
    }

    const importMaps = new Map<string, Map<string, { resolvedFileName: string, importedName: string }>>()

    for (const candidate of candidates) {
        const fileName = candidate.sourceFile.fileName
        const entry    = registry.get(registryKey(fileName, candidate.name))

        if (entry === undefined) {
            continue
        }

        let importMap = importMaps.get(fileName)

        if (importMap === undefined) {
            importMap = buildImportedNameMap(tsInstance, candidate.sourceFile, resolveModuleFileName)
            importMaps.set(fileName, importMap)
        }

        for (const implementsName of candidate.implementsNames) {
            const sameFileKey = registryKey(fileName, implementsName)

            if (registry.has(sameFileKey)) {
                entry.dependencies.push(sameFileKey)
                continue
            }

            const imported = importMap.get(implementsName)

            if (imported !== undefined) {
                const importedKey = registryKey(imported.resolvedFileName, imported.importedName)

                if (registry.has(importedKey)) {
                    entry.dependencies.push(importedKey)
                }
            }
        }
    }

    return registry
}

function registryKey(fileName: string, name: string): string {
    return `${normalizePath(fileName)}::${name}`
}

function normalizePath(fileName: string): string {
    return fileName.replaceAll("\\", "/")
}

// localName -> откуда импортировано (только успешно разрешённые именованные импорты)
function buildImportedNameMap(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined
): Map<string, { resolvedFileName: string, importedName: string }> {
    const importMap = new Map<string, { resolvedFileName: string, importedName: string }>()

    if (resolveModuleFileName === undefined) {
        return importMap
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue
        }

        const namedBindings = statement.importClause?.namedBindings

        if (namedBindings === undefined || !tsInstance.isNamedImports(namedBindings)) {
            continue
        }

        const resolvedFileName = resolveModuleFileName(statement.moduleSpecifier.text, sourceFile.fileName)

        if (resolvedFileName === undefined) {
            continue
        }

        for (const element of namedBindings.elements) {
            importMap.set(element.name.text, {
                resolvedFileName,
                importedName : element.propertyName?.text ?? element.name.text
            })
        }
    }

    return importMap
}

// ---------------------------------------------------------------------------
// Трансформация исходного файла

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

    if (context.byLocalName.size === 0) {
        return sourceFile
    }

    let expandedAnything = false

    const expandedStatements = sourceFile.statements.flatMap((statement): ts.Statement[] => {
        if (tsInstance.isClassDeclaration(statement) && statement.name !== undefined) {
            const ref = context.byLocalName.get(statement.name.text)

            if (ref !== undefined && ref.declaration === statement) {
                expandedAnything = true
                return expandMixinClass(tsInstance, sourceFile, ref, context)
            }

            if (consumedMixins(tsInstance, statement, context).length > 0) {
                expandedAnything = true
                return expandConsumerClass(tsInstance, sourceFile, statement, context)
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

// Сгенерированные импорты (хелперы типов + фабрики миксинов из других модулей)
// вставляются после последнего исходного импорта
function insertGeneratedImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory = tsInstance.factory

    const generatedImports: ts.ImportDeclaration[] = [ createHelperTypeImport(tsInstance, options) ]

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
// Контекст миксинов трансформируемого файла

function buildFileMixinContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions,
    crossFile?: CrossFileContext
): FileMixinContext {
    const context: FileMixinContext = {
        byLocalName        : new Map(),
        byKey              : new Map(),
        usedFactoryImports : new Map()
    }

    // 1. mixin-классы этого файла
    if (imports.identifiers.size > 0 || imports.namespaces.size > 0) {
        for (const statement of sourceFile.statements) {
            if (!tsInstance.isClassDeclaration(statement) ||
                !hasMixinDecorator(tsInstance, statement, imports, options)
            ) {
                continue
            }

            if (statement.name === undefined) {
                throw new MixinTransformError(sourceFile, statement, "A mixin class must have a name")
            }

            validateMixinClass(tsInstance, sourceFile, statement)

            const name = statement.name.text
            const ref: ResolvedMixinRef = {
                key              : registryKey(sourceFile.fileName, name),
                className        : name,
                localValueName   : name,
                localFactoryName : name + mixinFactorySuffix,
                factoryImport    : undefined,
                dependencies     : [],
                declaration      : statement
            }

            context.byLocalName.set(name, ref)
            context.byKey.set(ref.key, ref)
        }
    }

    // 2. импортированные mixin-классы (по реестру)
    if (crossFile !== undefined) {
        const importMap = buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName)

        for (const statement of sourceFile.statements) {
            if (!tsInstance.isImportDeclaration(statement) ||
                !tsInstance.isStringLiteral(statement.moduleSpecifier)
            ) {
                continue
            }

            const namedBindings = statement.importClause?.namedBindings

            if (namedBindings === undefined || !tsInstance.isNamedImports(namedBindings)) {
                continue
            }

            for (const element of namedBindings.elements) {
                const localName = element.name.text
                const imported  = importMap.get(localName)

                if (imported === undefined || context.byLocalName.has(localName)) {
                    continue
                }

                const key        = registryKey(imported.resolvedFileName, imported.importedName)
                const registered = crossFile.registry.get(key)

                if (registered === undefined) {
                    continue
                }

                const ref: ResolvedMixinRef = {
                    key,
                    className        : registered.name,
                    localValueName   : localName,
                    localFactoryName : localName + mixinFactorySuffix,
                    factoryImport    : {
                        specifier    : statement.moduleSpecifier.text,
                        importedName : imported.importedName + mixinFactorySuffix
                    },
                    dependencies     : registered.dependencies,
                    declaration      : undefined
                }

                context.byLocalName.set(localName, ref)
                context.byKey.set(key, ref)
            }
        }
    }

    // 3. зависимости same-file миксинов (по локальным именам из implements)
    for (const ref of context.byLocalName.values()) {
        if (ref.declaration === undefined) {
            continue
        }

        for (const heritageType of implementsTypes(tsInstance, ref.declaration)) {
            if (tsInstance.isIdentifier(heritageType.expression)) {
                const dependency = context.byLocalName.get(heritageType.expression.text)

                if (dependency !== undefined) {
                    ref.dependencies.push(dependency.key)
                }
            }
        }
    }

    // 4. транзитивное замыкание по реестру: зависимости, которые файл не импортирует
    if (crossFile !== undefined) {
        const queue = [ ...context.byKey.values() ].flatMap((ref) => ref.dependencies)

        while (queue.length > 0) {
            const key = queue.pop()

            if (key === undefined || context.byKey.has(key)) {
                continue
            }

            const registered = crossFile.registry.get(key)

            if (registered === undefined) {
                continue
            }

            context.byKey.set(key, {
                key,
                className        : registered.name,
                localValueName   : undefined,
                localFactoryName : registered.name + mixinFactorySuffix,
                factoryImport    : {
                    specifier    : relativeImportSpecifier(sourceFile.fileName, registered.fileName),
                    importedName : registered.name + mixinFactorySuffix
                },
                dependencies     : registered.dependencies,
                declaration      : undefined
            })

            queue.push(...registered.dependencies)
        }
    }

    return context
}

function relativeImportSpecifier(fromFileName: string, toFileName: string): string {
    const relative = path.posix.relative(
        path.posix.dirname(normalizePath(fromFileName)),
        normalizePath(toFileName)
    )

    const withoutExtension = relative
        .replace(/\.[cm]?tsx?$/, "")

    return withoutExtension.startsWith(".") ? withoutExtension : "./" + withoutExtension
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

// ---------------------------------------------------------------------------
// Трансформация mixin-класса
//
// Mixin-класс разворачивается в три декларации (см. SPEC.md):
//
//     interface X<T> { ...сигнатуры инстанс-членов... }
//     const X$mixin = <T>(base: AnyConstructor) => class extends base { ...тело... }
//     const X = X$mixin(Object) as unknown as
//         (new <T>(...args: any[]) => X<T>) & ClassStatics<ReturnType<typeof X$mixin>>

function expandMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef,
    context: FileMixinContext
): ts.Statement[] {
    const factory         = tsInstance.factory
    const declaration     = ref.declaration

    if (declaration === undefined) {
        throw new Error(`Mixin class ${ref.className} has no declaration in the transformed file`)
    }

    const exportModifiers = exportModifiersOf(tsInstance, declaration)
    const typeParameters  = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined

    const interfaceDeclaration = factory.createInterfaceDeclaration(
        exportModifiers,
        ref.className,
        typeParameters,
        interfaceHeritageClauses(tsInstance, declaration),
        buildInterfaceMembers(tsInstance, sourceFile, declaration)
    )

    const factoryStatement = factory.createVariableStatement(
        exportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                ref.localFactoryName,
                undefined,
                undefined,
                factory.createArrowFunction(
                    undefined,
                    typeParameters,
                    [ createBaseParameter(tsInstance, declaration, context) ],
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
                ref.className,
                undefined,
                undefined,
                factory.createAsExpression(
                    factory.createAsExpression(
                        createChainExpression(
                            tsInstance,
                            [ ...linearizeDependencies(ref.dependencies, context), ref ],
                            factory.createIdentifier("Object"),
                            context
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
    context: FileMixinContext
): ts.ParameterDeclaration {
    const factory = tsInstance.factory

    const dependencyTypes = implementsTypes(tsInstance, declaration)
        .filter((heritageType) => {
            return tsInstance.isIdentifier(heritageType.expression) &&
                context.byLocalName.has(heritageType.expression.text)
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

// ---------------------------------------------------------------------------
// Трансформация класса-потребителя
//
// Потребитель разворачивается в промежуточную базу с declaration merging (SPEC.md):
//
//     interface X$base<A> extends Mixin1<...>, Mixin2<...> {}
//     class X$base<A> extends (Mixin2$mixin(Mixin1$mixin(Base)) as unknown as
//         typeof Base & ClassStatics<typeof Mixin1> & ClassStatics<typeof Mixin2>) {}
//     class X<A> extends X$base<A> implements Mixin1<...>, Mixin2<...> { ...тело без изменений... }

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
    context: FileMixinContext
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

    const mixinHeritage = consumedMixins(tsInstance, declaration, context)
    const linearized    = linearizeDependencies(
        mixinHeritage.map((heritageType) => {
            return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!.key
        }),
        context
    )

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
                                    : factory.createIdentifier("Object"),
                                context
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
// плюс статика каждого применённого миксина, чьё значение доступно в файле
function createConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const factory = tsInstance.factory

    const types = [
        extendsType !== undefined
            ? factory.createTypeQueryNode(expressionToEntityName(tsInstance, extendsType.expression))
            : factory.createTypeReferenceNode(anyConstructorName, undefined),
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

// ---------------------------------------------------------------------------
// Линеаризация и построение runtime-цепочки

function linearizeDependencies(
    dependencyKeys: string[],
    context: FileMixinContext,
    seen: Set<string> = new Set()
): ResolvedMixinRef[] {
    const linearized: ResolvedMixinRef[] = []

    for (const key of dependencyKeys) {
        if (seen.has(key)) {
            continue
        }

        seen.add(key)

        const ref = context.byKey.get(key)

        if (ref !== undefined) {
            linearized.push(...linearizeDependencies(ref.dependencies, context, seen), ref)
        }
    }

    return linearized
}

function createChainExpression(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[],
    baseExpression: ts.Expression,
    context: FileMixinContext
): ts.Expression {
    const factory = tsInstance.factory

    let expression = baseExpression

    for (const ref of mixinRefs) {
        if (ref.factoryImport !== undefined) {
            context.usedFactoryImports.set(`${ref.factoryImport.specifier}::${ref.localFactoryName}`, {
                specifier    : ref.factoryImport.specifier,
                importedName : ref.factoryImport.importedName,
                localName    : ref.localFactoryName
            })
        }

        expression = factory.createCallExpression(
            factory.createIdentifier(ref.localFactoryName),
            undefined,
            [ expression ]
        )
    }

    return expression
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
    const normalizedFileName = normalizePath(fileName)

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
