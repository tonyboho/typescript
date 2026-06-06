import type * as ts from "typescript"
import type { PluginConfig, ProgramTransformerExtras } from "ts-patch"

type TypeScript = ProgramTransformerExtras["ts"]
type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}
type MutableNode = ts.Node & {
    flags : ts.NodeFlags
}

export type LazyPropertyTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string,
    backingPrefix? : string
}

type TransformOptions = {
    packageName : string,
    decoratorName : string,
    backingPrefix : string,
    preserveLazyDecorator : boolean
}

type TransformSourceFileOptions = Partial<TransformOptions>

const defaultTransformOptions: TransformOptions = {
    packageName           : "ts-lazy-property",
    decoratorName         : "lazy",
    backingPrefix         : "$",
    preserveLazyDecorator : false
}

type LazyDecoratorImports = {
    identifiers : Set<string>,
    namespaces  : Set<string>
}

export function lazy(): (..._args: unknown[]) => void {
    return () => {}
}

export function createLazyPropertyCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: LazyPropertyTransformerConfig
): ts.CompilerHost {
    const options = {
        packageName           : config.packageName ?? "ts-lazy-property",
        decoratorName         : config.decoratorName ?? "lazy",
        backingPrefix         : config.backingPrefix ?? "$",
        preserveLazyDecorator : false
    }
    const sourceCache = new Map<string, ts.SourceFile>()

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const usePrintedSourceFile = shouldCreatePrintedSourceFileForEmit(compilerOptions)
            const sourceFile           = compilerHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                usePrintedSourceFile ? shouldCreateNewSourceFile : true
            )

            if (sourceFile === undefined || shouldSkipSourceFile(sourceFile)) {
                return sourceFile
            }

            if (usePrintedSourceFile) {
                const cacheKey = sourceFileCacheKey(fileName, shouldCreateNewSourceFile, sourceFile)
                const cached   = sourceCache.get(cacheKey)

                if (cached !== undefined) {
                    return cached
                }

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

            return transformSourceFile(tsInstance, sourceFile, {
                ...options,
                preserveLazyDecorator : true
            })
        }
    }
}

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: LazyPropertyTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions = program.getCompilerOptions()
    const compilerHost    = host ?? tsInstance.createCompilerHost(compilerOptions)
    const nextHost        = createLazyPropertyCompilerHost(tsInstance, compilerHost, compilerOptions, config)
    const nextProgram     = tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        program
    )

    return filterGeneratedBackingDiagnostics(tsInstance, nextProgram, {
        packageName           : config.packageName ?? "ts-lazy-property",
        decoratorName         : config.decoratorName ?? "lazy",
        backingPrefix         : config.backingPrefix ?? "$",
        preserveLazyDecorator : false
    })
}

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformSourceFileOptions = {}
): ts.SourceFile {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    if (!sourceFile.text.includes(resolvedOptions.packageName)) {
        return sourceFile
    }

    const lazyDecoratorImports = collectLazyDecoratorImports(tsInstance, sourceFile, resolvedOptions)

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
                    if (!isLazyProperty(tsInstance, member, lazyDecoratorImports, resolvedOptions)) {
                        members.push(tsInstance.visitEachChild(member, visit, context) as ts.ClassElement)
                        continue
                    }

                    changed = true
                    members.push(...createLazyMembers(tsInstance, sourceFile, member, lazyDecoratorImports, resolvedOptions))
                }

                if (tsInstance.isClassDeclaration(node)) {
                    return context.factory.updateClassDeclaration(
                        node,
                        node.modifiers,
                        node.name,
                        node.typeParameters,
                        node.heritageClauses,
                        createClassMembersNodeArray(tsInstance, members, node.members)
                    )
                }

                return context.factory.updateClassExpression(
                    node,
                    node.modifiers,
                    node.name,
                    node.typeParameters,
                    node.heritageClauses,
                    createClassMembersNodeArray(tsInstance, members, node.members)
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

function filterGeneratedBackingDiagnostics(
    tsInstance: TypeScript,
    program: ts.Program,
    options: TransformOptions
): ts.Program {
    const getSemanticDiagnostics = program.getSemanticDiagnostics.bind(program)
    const backingNamesBySourceFile = new WeakMap<ts.SourceFile, Set<string>>()

    ;(program as ts.Program & {
        getSemanticDiagnostics : ts.Program["getSemanticDiagnostics"]
    }).getSemanticDiagnostics = (sourceFile, cancellationToken) => {
        return getSemanticDiagnostics(sourceFile, cancellationToken).filter((diagnostic) => {
            return !isGeneratedBackingAccessDiagnostic(tsInstance, diagnostic, options, backingNamesBySourceFile)
        })
    }

    return program
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

    const factory       = tsInstance.factory
    const propertyName  = property.name.text
    const backingName   = `${options.backingPrefix}${propertyName}`
    const memberRange   = lazyMemberRange(sourceFile, property)
    const nameStart     = property.name.getStart(sourceFile)
    const nameEnd       = property.name.getEnd()
    const typeEnd       = property.type.end
    const bodyRange     = {
        pos : typeEnd,
        end : property.end
    }
    const backingMemberRange = options.preserveLazyDecorator
        ? {
            pos : property.pos,
            end : nameStart
        }
        : memberRange
    const setterMemberRange = options.preserveLazyDecorator
        ? zeroWidthRange(property.end)
        : memberRange
    const backingModifiers = options.preserveLazyDecorator
        ? property.modifiers
        : removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)
    const getterModifiers = removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)
    const generatedMemberRange = options.preserveLazyDecorator
        ? memberRange
        : property
    const backingAccess = () => preserveTextRange(tsInstance, createThisPropertyAccess(tsInstance, backingName), generatedMemberRange)
    const valueParameter = preserveTextRange(tsInstance, factory.createParameterDeclaration(
        undefined,
        undefined,
        preserveTextRange(tsInstance, factory.createIdentifier("value"), zeroWidthRange(nameEnd)),
        undefined,
        property.type
    ), zeroWidthRange(nameEnd))
    const getterParameters = preserveTextRange(tsInstance, factory.createNodeArray([]), zeroWidthRange(nameEnd))
    const setterParameters = preserveTextRange(tsInstance, factory.createNodeArray([ valueParameter ]), zeroWidthRange(nameEnd))
    const isReadonly  = hasReadonlyModifier(tsInstance, property)
    const backingType = options.preserveLazyDecorator
        ? preserveTextRange(tsInstance, createOptionalLazyValueType(tsInstance, property.type), zeroWidthRange(nameStart))
        : createOptionalLazyValueType(tsInstance, property.type)

    const backingProperty = preserveTextRange(tsInstance, factory.createPropertyDeclaration(
        removeReadonlyModifier(tsInstance, backingModifiers),
        options.preserveLazyDecorator
            ? preserveTextRange(tsInstance, factory.createIdentifier(backingName), zeroWidthRange(nameStart))
            : preserveNodeNameLocation(tsInstance, factory.createIdentifier(backingName), sourceFile, property.name),
        undefined,
        backingType,
        options.preserveLazyDecorator
            ? preserveTextRange(tsInstance, factory.createIdentifier("undefined"), zeroWidthRange(nameStart))
            : preserveNodeLocation(tsInstance, factory.createIdentifier("undefined"), property.initializer)
    ), backingMemberRange)

    const getter = preserveTextRange(tsInstance, factory.createGetAccessorDeclaration(
        removeReadonlyModifier(tsInstance, getterModifiers),
        preserveNodeNameLocation(tsInstance, factory.createIdentifier(propertyName), sourceFile, property.name),
        getterParameters,
        property.type,
        preserveTextRange(tsInstance, factory.createBlock(preserveTextRange(tsInstance, factory.createNodeArray([
            preserveTextRange(tsInstance, factory.createIfStatement(
                factory.createBinaryExpression(
                    backingAccess(),
                    tsInstance.SyntaxKind.ExclamationEqualsEqualsToken,
                    factory.createIdentifier("undefined")
                ),
                factory.createReturnStatement(backingAccess())
            ), generatedMemberRange),
            preserveTextRange(tsInstance, factory.createReturnStatement(
                factory.createAssignment(
                    backingAccess(),
                    property.initializer
                )
            ), generatedMemberRange)
        ]), bodyRange), true), bodyRange)
    ), memberRange)

    const result: ts.ClassElement[] = [
        backingProperty,
        getter
    ]

    if (!isReadonly) {
        const setter = preserveTextRange(tsInstance, factory.createSetAccessorDeclaration(
            removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options),
            preserveNodeNameLocation(tsInstance, factory.createIdentifier(propertyName), sourceFile, property.name),
            setterParameters,
            preserveTextRange(tsInstance, factory.createBlock(preserveTextRange(tsInstance, factory.createNodeArray([
                preserveTextRange(tsInstance, factory.createExpressionStatement(
                    factory.createAssignment(
                        backingAccess(),
                        factory.createIdentifier("value")
                    )
                ), generatedMemberRange)
            ]), bodyRange), true), bodyRange)
        ), setterMemberRange)

        result.push(setter)
    }

    for (const member of result) {
        clearSynthesizedFlags(tsInstance, member)
    }

    return result
}

function isGeneratedBackingAccessDiagnostic(
    tsInstance: TypeScript,
    diagnostic: ts.Diagnostic,
    options: TransformOptions,
    backingNamesBySourceFile: WeakMap<ts.SourceFile, Set<string>>
): boolean {
    if (diagnostic.code !== 2551 || diagnostic.file === undefined || diagnostic.start === undefined) {
        return false
    }

    const backingName = diagnosticText(diagnostic)

    if (!backingName.startsWith(options.backingPrefix)) {
        return false
    }

    let backingNames = backingNamesBySourceFile.get(diagnostic.file)

    if (backingNames === undefined) {
        backingNames = collectExpectedBackingPropertyNames(tsInstance, diagnostic.file, options)
        backingNamesBySourceFile.set(diagnostic.file, backingNames)
    }

    return backingNames.has(backingName)
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
    const text = diagnostic.file?.text ?? ""
    const start = diagnostic.start ?? 0
    const match = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/u.exec(text.slice(start))

    return match?.[0] ?? text.slice(start, start + (diagnostic.length ?? 0))
}

function collectExpectedBackingPropertyNames(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Set<string> {
    const backingNames = new Set<string>()
    const lazyDecoratorImports = collectLazyDecoratorImports(tsInstance, sourceFile, options)

    const visit = (node: ts.Node): void => {
        if (tsInstance.isPropertyDeclaration(node) && tsInstance.isIdentifier(node.name)) {
            if (node.name.text.startsWith(options.backingPrefix)) {
                backingNames.add(node.name.text)
            } else if (isLazyProperty(tsInstance, node, lazyDecoratorImports, options)) {
                backingNames.add(`${options.backingPrefix}${node.name.text}`)
            }
        }

        tsInstance.forEachChild(node, visit)
    }

    visit(sourceFile)

    return backingNames
}

function createOptionalLazyValueType(tsInstance: TypeScript, type: ts.TypeNode): ts.TypeNode {
    return preserveTextRange(tsInstance, tsInstance.factory.createUnionTypeNode([
        type,
        preserveTextRange(tsInstance, tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.UndefinedKeyword), {
            pos : type.end,
            end : type.end
        })
    ]), type)
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
    return preserveTextRange(tsInstance, node, original)
}

function createClassMembersNodeArray(
    tsInstance: TypeScript,
    members: ts.ClassElement[],
    original: ts.NodeArray<ts.ClassElement>
): ts.NodeArray<ts.ClassElement> {
    const nodeArray = tsInstance.factory.createNodeArray(members)
    const firstMember = members.find((member) => {
        return member.pos >= 0
    })

    return preserveTextRange(tsInstance, nodeArray, {
        pos : firstMember?.pos ?? original.pos,
        end : original.end
    })
}

function lazyMemberRange(
    sourceFile: ts.SourceFile,
    property: ts.PropertyDeclaration
): ts.TextRange {
    return {
        pos : property.name.getStart(sourceFile),
        end : property.end
    }
}

function zeroWidthRange(pos: number): ts.TextRange {
    return {
        pos,
        end : pos
    }
}

function preserveTextRange<Range extends ts.TextRange>(
    tsInstance: TypeScript,
    range: Range,
    original: ts.TextRange
): Range {
    tsInstance.setTextRange(range, original)

    return range
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

function clearSynthesizedFlags(tsInstance: TypeScript, node: ts.Node): void {
    (node as MutableNode).flags &= ~tsInstance.NodeFlags.Synthesized

    tsInstance.forEachChild(node, (child) => {
        clearSynthesizedFlags(tsInstance, child)
    })
}

function removeLazyDecoratorModifiers(
    tsInstance: TypeScript,
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): ts.NodeArray<ts.ModifierLike> | undefined {
    return filterModifiers(tsInstance, modifiers, (modifier) => {
        return !tsInstance.isDecorator(modifier) ||
            !isLazyDecorator(tsInstance, modifier, lazyDecoratorImports, options)
    })
}

function hasReadonlyModifier(
    tsInstance: TypeScript,
    property: ts.PropertyDeclaration
): boolean {
    if (!tsInstance.canHaveModifiers(property)) {
        return false
    }

    return tsInstance.getModifiers(property)?.some((modifier) => {
        return modifier.kind === tsInstance.SyntaxKind.ReadonlyKeyword
    }) ?? false
}

function removeReadonlyModifier(
    tsInstance: TypeScript,
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined
): ts.NodeArray<ts.ModifierLike> | undefined {
    return filterModifiers(tsInstance, modifiers, (modifier) => {
        return modifier.kind !== tsInstance.SyntaxKind.ReadonlyKeyword
    })
}

function filterModifiers(
    tsInstance: TypeScript,
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
    keep: (modifier: ts.ModifierLike) => boolean
): ts.NodeArray<ts.ModifierLike> | undefined {
    if (modifiers === undefined) {
        return undefined
    }

    const next = modifiers.filter(keep)

    if (next.length === 0) {
        return undefined
    }

    if (next.length === modifiers.length) {
        return modifiers
    }

    return preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(next), modifiers)
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

type SourceFileWithVersion = ts.SourceFile & {
    version? : string
}

function sourceFileCacheKey(
    fileName: string,
    shouldCreateNewSourceFile: boolean | undefined,
    sourceFile: ts.SourceFile
): string {
    const version = (sourceFile as SourceFileWithVersion).version ?? ""

    // Version alone is not enough: the language service can supply new text before
    // the script version is bumped, which would otherwise return a stale transform.
    return `${fileName}:${String(shouldCreateNewSourceFile)}:${version}:${sourceFile.text}`
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
