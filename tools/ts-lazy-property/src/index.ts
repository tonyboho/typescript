import type * as ts from "typescript"
import type { PluginConfig, ProgramTransformerExtras } from "ts-patch"

type TypeScript = ProgramTransformerExtras["ts"]
type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}

export type LazyPropertyTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string,
    backingPrefix? : string
}

type TransformOptions = {
    packageName : string,
    decoratorName : string,
    backingPrefix : string
}

type LazyDecoratorImports = {
    identifiers : Set<string>,
    namespaces  : Set<string>
}

export function lazy(): (..._args: unknown[]) => void {
    return () => {}
}

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: LazyPropertyTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const options = {
        packageName   : config.packageName ?? "ts-lazy-property",
        decoratorName : config.decoratorName ?? "lazy",
        backingPrefix : config.backingPrefix ?? "$"
    }

    const compilerOptions = program.getCompilerOptions()
    const compilerHost    = host ?? tsInstance.createCompilerHost(compilerOptions)
    const sourceCache     = new Map<string, ts.SourceFile>()

    const nextHost: ts.CompilerHost = {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const cacheKey = `${fileName}:${String(shouldCreateNewSourceFile)}`
            const cached   = sourceCache.get(cacheKey)

            if (cached !== undefined) {
                return cached
            }

            const sourceFile = shouldCreateNewSourceFile
                ? compilerHost.getSourceFile(
                    fileName,
                    languageVersionOrOptions,
                    onError,
                    shouldCreateNewSourceFile
                )
                : program.getSourceFile(fileName) ?? compilerHost.getSourceFile(
                    fileName,
                    languageVersionOrOptions,
                    onError,
                    shouldCreateNewSourceFile
                )

            if (sourceFile === undefined || shouldSkipSourceFile(sourceFile)) {
                return sourceFile
            }

            if (shouldCreatePrintedSourceFileForEmit(compilerOptions)) {
                const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options)

                if (transformedSourceFile === sourceFile) {
                    sourceCache.set(cacheKey, sourceFile)
                    return sourceFile
                }

                const transformedText = printSourceFile(tsInstance, transformedSourceFile)
                const printedSourceFile = tsInstance.createSourceFile(
                    fileName,
                    transformedText,
                    languageVersionOrOptions,
                    true,
                    scriptKindFromFileName(tsInstance, fileName)
                )

                sourceCache.set(cacheKey, printedSourceFile)

                return printedSourceFile
            }

            const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options)

            if (transformedSourceFile === sourceFile) {
                sourceCache.set(cacheKey, sourceFile)
                return sourceFile
            }

            sourceCache.set(cacheKey, transformedSourceFile)

            return transformedSourceFile
        }
    }

    return tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost
    )
}

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions = {
        packageName   : "ts-lazy-property",
        decoratorName : "lazy",
        backingPrefix : "$"
    }
): ts.SourceFile {
    if (!sourceFile.text.includes(options.packageName)) {
        return sourceFile
    }

    const lazyDecoratorImports = collectLazyDecoratorImports(tsInstance, sourceFile, options)

    if (lazyDecoratorImports.identifiers.size === 0 && lazyDecoratorImports.namespaces.size === 0) {
        return sourceFile
    }

    let changed = false

    const transformed = tsInstance.transform(sourceFile, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (!tsInstance.isClassDeclaration(node) && !tsInstance.isClassExpression(node)) {
                    return tsInstance.visitEachChild(node, visit, context)
                }

                const members: ts.ClassElement[] = []

                for (const member of node.members) {
                    if (!isLazyProperty(tsInstance, member, lazyDecoratorImports, options)) {
                        members.push(tsInstance.visitEachChild(member, visit, context) as ts.ClassElement)
                        continue
                    }

                    changed = true
                    members.push(...createLazyMembers(tsInstance, sourceFile, member, lazyDecoratorImports, options))
                }

                if (tsInstance.isClassDeclaration(node)) {
                    return context.factory.updateClassDeclaration(
                        node,
                        node.modifiers,
                        node.name,
                        node.typeParameters,
                        node.heritageClauses,
                        members
                    )
                }

                return context.factory.updateClassExpression(
                    node,
                    node.modifiers,
                    node.name,
                    node.typeParameters,
                    node.heritageClauses,
                    members
                )
            }

            return (nextSourceFile) => tsInstance.visitNode(nextSourceFile, visit) as ts.SourceFile
        }
    ])

    try {
        if (!changed) {
            return sourceFile
        }

        return (tsInstance as TypeScriptWithParents).setParentRecursive(transformed.transformed[0], false)
    } finally {
        transformed.dispose()
    }
}

export function printSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): string {
    return tsInstance.createPrinter().printFile(sourceFile)
}

function createLazyMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    property: ts.PropertyDeclaration,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): ts.ClassElement[] {
    if (!tsInstance.isIdentifier(property.name)) {
        throw new Error("@lazy only supports identifier property names.")
    }

    if (property.type === undefined) {
        throw new Error(`@lazy property "${property.name.text}" must have an explicit type.`)
    }

    if (property.initializer === undefined) {
        throw new Error(`@lazy property "${property.name.text}" must have an initializer.`)
    }

    const factory        = tsInstance.factory
    const propertyName   = property.name.text
    const backingName    = `${options.backingPrefix}${propertyName}`
    const backingAccess  = () => preserveNodeLocation(tsInstance, createThisPropertyAccess(tsInstance, backingName), property)
    const valueParameter = preserveNodeLocation(tsInstance, factory.createParameterDeclaration(
        undefined,
        undefined,
        preserveNodeNameLocation(tsInstance, factory.createIdentifier("value"), sourceFile, property.name),
        undefined,
        property.type
    ), property)

    const backingProperty = preserveNodeLocation(tsInstance, factory.createPropertyDeclaration(
        removeReadonlyModifier(
            tsInstance,
            removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)
        ),
        preserveNodeNameLocation(tsInstance, factory.createIdentifier(backingName), sourceFile, property.name),
        undefined,
        createOptionalLazyValueType(tsInstance, property.type),
        factory.createIdentifier("undefined")
    ), property)

    const getter = preserveNodeLocation(tsInstance, factory.createGetAccessorDeclaration(
        removeReadonlyModifier(tsInstance, removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)),
        preserveNodeNameLocation(tsInstance, factory.createIdentifier(propertyName), sourceFile, property.name),
        [],
        property.type,
        factory.createBlock([
            preserveNodeLocation(tsInstance, factory.createIfStatement(
                factory.createBinaryExpression(
                    backingAccess(),
                    tsInstance.SyntaxKind.ExclamationEqualsEqualsToken,
                    factory.createIdentifier("undefined")
                ),
                factory.createReturnStatement(backingAccess())
            ), property),
            preserveNodeLocation(tsInstance, factory.createReturnStatement(
                factory.createAssignment(
                    backingAccess(),
                    property.initializer
                )
            ), property)
        ], true)
    ), property)

    const setter = preserveNodeLocation(tsInstance, factory.createSetAccessorDeclaration(
        removeReadonlyModifier(tsInstance, removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)),
        preserveNodeNameLocation(tsInstance, factory.createIdentifier(propertyName), sourceFile, property.name),
        [ valueParameter ],
        factory.createBlock([
            preserveNodeLocation(tsInstance, factory.createExpressionStatement(
                factory.createAssignment(
                    backingAccess(),
                    factory.createIdentifier("value")
                )
            ), property)
        ], true)
    ), property)

    return [
        backingProperty,
        getter,
        setter
    ]
}

function createOptionalLazyValueType(tsInstance: TypeScript, type: ts.TypeNode): ts.TypeNode {
    return tsInstance.factory.createUnionTypeNode([
        type,
        tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.UndefinedKeyword)
    ])
}

function createThisPropertyAccess(tsInstance: TypeScript, propertyName: string): ts.PropertyAccessExpression {
    return tsInstance.factory.createPropertyAccessExpression(
        tsInstance.factory.createThis(),
        propertyName
    )
}

function preserveNodeLocation<Node extends ts.Node>(
    tsInstance: TypeScript,
    node: Node,
    original: ts.Node
): Node {
    tsInstance.setTextRange(node, original)

    return node
}

function preserveNodeNameLocation<Node extends ts.Node>(
    tsInstance: TypeScript,
    node: Node,
    sourceFile: ts.SourceFile,
    original: ts.Node
): Node {
    tsInstance.setTextRange(node, {
        pos : original.getStart(sourceFile),
        end : original.getEnd()
    })

    return node
}

function removeLazyDecoratorModifiers(
    tsInstance: TypeScript,
    modifiers: readonly ts.ModifierLike[] | undefined,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): ts.ModifierLike[] | undefined {
    const next = modifiers?.filter((modifier) => {
        return !tsInstance.isDecorator(modifier) ||
            !isLazyDecorator(tsInstance, modifier, lazyDecoratorImports, options)
    })

    return next?.length ? next : undefined
}

function removeReadonlyModifier(
    tsInstance: TypeScript,
    modifiers: readonly ts.ModifierLike[] | undefined
): ts.ModifierLike[] | undefined {
    const next = modifiers?.filter((modifier) => {
        return modifier.kind !== tsInstance.SyntaxKind.ReadonlyKeyword
    })

    return next?.length ? next : undefined
}

function isLazyProperty(
    tsInstance: TypeScript,
    node: ts.ClassElement,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): node is ts.PropertyDeclaration {
    return tsInstance.isPropertyDeclaration(node) &&
        getLazyDecorator(tsInstance, node, lazyDecoratorImports, options) !== undefined
}

function getLazyDecorator(
    tsInstance: TypeScript,
    node: ts.HasDecorators,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): ts.Decorator | undefined {
    return tsInstance.getDecorators(node)?.find((decorator) => {
        return isLazyDecorator(tsInstance, decorator, lazyDecoratorImports, options)
    })
}

function isLazyDecorator(
    tsInstance: TypeScript,
    decorator: ts.Decorator,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): boolean {
    const expression = decorator.expression

    if (!tsInstance.isCallExpression(expression) || expression.arguments.length !== 0) {
        return false
    }

    return isLazyDecoratorExpression(tsInstance, expression.expression, lazyDecoratorImports, options)
}

function isLazyDecoratorExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return lazyDecoratorImports.identifiers.has(expression.text)
    }

    if (!tsInstance.isPropertyAccessExpression(expression)) {
        return false
    }

    return tsInstance.isIdentifier(expression.expression) &&
        lazyDecoratorImports.namespaces.has(expression.expression.text) &&
        expression.name.text === options.decoratorName
}

function collectLazyDecoratorImports(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): LazyDecoratorImports {
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
    return fileName.includes("/node_modules/") ||
        fileName.endsWith(".d.ts") ||
        !/\.[cm]?tsx?$/.test(fileName)
}

function scriptKindFromFileName(tsInstance: TypeScript, fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx") || fileName.endsWith(".mtsx") || fileName.endsWith(".ctsx")) {
        return tsInstance.ScriptKind.TSX
    }

    return tsInstance.ScriptKind.TS
}
