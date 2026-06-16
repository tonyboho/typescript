import type * as ts from "typescript"
import type { PluginConfig, ProgramTransformerExtras } from "ts-patch"

type TypeScript = ProgramTransformerExtras["ts"]
type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}
type NodeFactoryWithCloneNode = ts.NodeFactory & {
    cloneNode<Node extends ts.Node>(node: Node): Node
}
type MutableNode = ts.Node & {
    flags : ts.NodeFlags
}

export type LazyPropertyTransformerMode = "emit" | "ide"

export type LazyPropertyTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string,
    backingPrefix? : string,
    mode? : LazyPropertyTransformerMode
}

type TransformOptions = {
    packageName : string,
    decoratorName : string,
    backingPrefix : string,
    preserveLazyDecorator : boolean
}

type TransformSourceFileOptions = Partial<TransformOptions> & {
    trustSourceText? : boolean
}

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

function resolveTransformOptions(config: LazyPropertyTransformerConfig): TransformOptions {
    return {
        packageName           : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName         : config.decoratorName ?? defaultTransformOptions.decoratorName,
        backingPrefix         : config.backingPrefix ?? defaultTransformOptions.backingPrefix,
        preserveLazyDecorator : false
    }
}

// Keyed by the layered (base program) SourceFile object identity. Hosts can report a
// stale `version` for changed text (see compiler-host-stale-source.t.ts), so object
// identity is the only safe invalidation signal: tsserver reuses SourceFile objects
// across program generations for unchanged files and creates new ones on edits.
const preserveSourceCache = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()

export function createLazyPropertyCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: LazyPropertyTransformerConfig,
    baseProgram?: ts.Program
): ts.CompilerHost {
    const options = resolveTransformOptions(config)
    const sourceCache = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()
    const usePrintedSourceFile = resolveUsePrintedSourceFile(config, compilerOptions)

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const layeredSourceFile = baseProgram?.getSourceFile(fileName)
            const preserveCacheKey = usePrintedSourceFile
                ? undefined
                : preserveSourceCacheKey(options, languageVersionOrOptions)

            if (preserveCacheKey !== undefined && layeredSourceFile !== undefined) {
                const cached = preserveSourceCache.get(layeredSourceFile)?.get(preserveCacheKey)

                if (cached !== undefined) {
                    return cached
                }
            }

            const cachePreserveSourceFile = (result: ts.SourceFile): ts.SourceFile => {
                if (preserveCacheKey !== undefined && layeredSourceFile !== undefined) {
                    setCachedSourceFile(preserveSourceCache, layeredSourceFile, preserveCacheKey, result)
                }

                return result
            }

            const hostSourceFile = compilerHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                usePrintedSourceFile ? shouldCreateNewSourceFile : true
            )
            const useLayeredSourceFile = layeredSourceFile !== undefined &&
                (
                    hostSourceFile === undefined ||
                    layeredSourceFile !== hostSourceFile && hasDifferentAstShape(tsInstance, layeredSourceFile, hostSourceFile)
                )
            const sourceFile = useLayeredSourceFile ? layeredSourceFile : hostSourceFile

            if (sourceFile === undefined) {
                return sourceFile
            }

            if (shouldSkipSourceFile(sourceFile)) {
                return cachePreserveSourceFile(sourceFile)
            }

            if (usePrintedSourceFile) {
                const cacheKey = String(shouldCreateNewSourceFile)
                const cached   = sourceCache.get(sourceFile)?.get(cacheKey)

                if (cached !== undefined) {
                    return cached
                }

                const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, {
                    ...options,
                    trustSourceText : !useLayeredSourceFile
                })

                if (transformedSourceFile === sourceFile) {
                    setCachedSourceFile(sourceCache, sourceFile, cacheKey, sourceFile)
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

                setCachedSourceFile(sourceCache, sourceFile, cacheKey, printedSourceFile)

                return printedSourceFile
            }

            const transformSourceFileInput = useLayeredSourceFile
                ? cloneLayeredSourceFileForTransform(tsInstance, sourceFile)
                : cloneSourceFileForTransform(tsInstance, sourceFile, languageVersionOrOptions)

            return cachePreserveSourceFile(transformSourceFile(tsInstance, transformSourceFileInput, {
                ...options,
                preserveLazyDecorator : true,
                trustSourceText       : !useLayeredSourceFile
            }))
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
    const nextHost        = createLazyPropertyCompilerHost(tsInstance, compilerHost, compilerOptions, config, program)

    return tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        undefined
    )
}

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformSourceFileOptions = {}
): ts.SourceFile {
    const { trustSourceText = false, ...transformOptions } = options
    const resolvedOptions: TransformOptions = {
        ...defaultTransformOptions,
        ...transformOptions
    }

    if (!sourceFile.text.includes(resolvedOptions.packageName)) {
        return sourceFile
    }

    const lazyDecoratorImports = collectLazyDecoratorImports(tsInstance, sourceFile, resolvedOptions)

    if (lazyDecoratorImports.identifiers.size === 0 && lazyDecoratorImports.namespaces.size === 0) {
        return sourceFile
    }

    if (!sourceFile.text.includes("@")) {
        if (trustSourceText || !hasLazyPropertyInSourceFile(tsInstance, sourceFile, lazyDecoratorImports, resolvedOptions)) {
            return sourceFile
        }
    }

    let changed = false

    const transformed = tsInstance.transform(sourceFile, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (!tsInstance.isClassDeclaration(node) && !tsInstance.isClassExpression(node)) {
                    return tsInstance.visitEachChild(node, visit, context)
                }

                if (!hasOwnLazyProperty(tsInstance, node, lazyDecoratorImports, resolvedOptions)) {
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

function cloneSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): ts.SourceFile {
    // Preserve-mode programs must not share language-service SourceFile nodes.
    // TypeScript stores checker/navigation state on AST nodes.
    const cloned = tsInstance.createSourceFile(
        sourceFile.fileName,
        sourceFile.text,
        languageVersionOrOptions,
        true,
        scriptKindFromFileName(tsInstance, sourceFile.fileName)
    )

    ;(cloned as SourceFileWithVersion).version = (sourceFile as SourceFileWithVersion).version

    return cloned
}

function hasDifferentAstShape(
    tsInstance: TypeScript,
    left: ts.SourceFile,
    right: ts.SourceFile
): boolean {
    const leftStack: ts.Node[] = [ left ]
    const rightStack: ts.Node[] = [ right ]
    const leftChildren: ts.Node[] = []
    const rightChildren: ts.Node[] = []
    const collectChildren = (node: ts.Node, children: ts.Node[]): void => {
        children.length = 0

        tsInstance.forEachChild(node, (child) => {
            children.push(child)
        })
    }

    while (leftStack.length > 0) {
        const leftNode = leftStack.pop() as ts.Node
        const rightNode = rightStack.pop()

        if (rightNode === undefined) {
            return true
        }

        if (leftNode.kind !== rightNode.kind || leftNode.pos !== rightNode.pos || leftNode.end !== rightNode.end) {
            return true
        }

        collectChildren(leftNode, leftChildren)
        collectChildren(rightNode, rightChildren)

        if (leftChildren.length !== rightChildren.length) {
            return true
        }

        for (let index = leftChildren.length - 1; index >= 0; index--) {
            leftStack.push(leftChildren[index])
            rightStack.push(rightChildren[index])
        }
    }

    return rightStack.length !== 0
}

function cloneLayeredSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): ts.SourceFile {
    const cloneNode = (tsInstance.factory as NodeFactoryWithCloneNode).cloneNode.bind(tsInstance.factory)
    const transformed = tsInstance.transform(sourceFile, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                return cloneNode(tsInstance.visitEachChild(node, visit, context))
            }

            return (nextSourceFile) => tsInstance.visitNode(nextSourceFile, visit) as ts.SourceFile
        }
    ])

    try {
        const cloned = transformed.transformed[0]

        ;(cloned as SourceFileWithVersion).version = (sourceFile as SourceFileWithVersion).version

        return (tsInstance as TypeScriptWithParents).setParentRecursive(cloned, false)
    } finally {
        transformed.dispose()
    }
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
    const getterMemberRange = memberRange
    const nameStart     = property.name.getStart(sourceFile)
    const nameEnd       = property.name.getEnd()
    const typeEnd       = property.type.end
    const bodyRange     = {
        pos : typeEnd,
        end : property.end
    }
    const lazyRemovedModifiers = removeLazyDecoratorModifiers(tsInstance, property.modifiers, lazyDecoratorImports, options)
    const backingMemberRange = options.preserveLazyDecorator
        ? {
            pos : property.pos,
            end : property.name.pos
        }
        : memberRange
    const backingModifiers = options.preserveLazyDecorator
        ? property.modifiers
        : lazyRemovedModifiers
    const createAccessorModifiers = () => options.preserveLazyDecorator
        ? moveModifierTextRanges(
            tsInstance,
            lazyRemovedModifiers,
            zeroWidthRange(nameStart)
        )
        : lazyRemovedModifiers
    const setterMemberRange = options.preserveLazyDecorator
        ? zeroWidthRange(property.end)
        : memberRange
    const generatedMemberRange = options.preserveLazyDecorator
        ? memberRange
        : property
    const backingAccess = () => preserveTextRange(tsInstance, createThisPropertyAccess(tsInstance, backingName), generatedMemberRange)
    const getterParameters = preserveTextRange(tsInstance, factory.createNodeArray([]), zeroWidthRange(nameEnd))
    const isReadonly  = hasReadonlyModifier(tsInstance, property)
    const backingType = options.preserveLazyDecorator
        ? preserveTextRange(tsInstance, createOptionalLazyValueType(tsInstance, property.type), zeroWidthRange(nameStart))
        : createOptionalLazyValueType(tsInstance, property.type)

    const backingProperty = preserveTextRange(tsInstance, factory.createPropertyDeclaration(
        removeReadonlyModifier(tsInstance, backingModifiers),
        preserveNodeNameLocation(tsInstance, factory.createIdentifier(backingName), sourceFile, property.name),
        undefined,
        backingType,
        options.preserveLazyDecorator
            ? preserveTextRange(tsInstance, factory.createIdentifier("undefined"), zeroWidthRange(nameStart))
            : preserveTextRange(tsInstance, factory.createIdentifier("undefined"), property.initializer)
    ), backingMemberRange)

    const getter = preserveTextRange(tsInstance, factory.createGetAccessorDeclaration(
        removeReadonlyModifier(tsInstance, createAccessorModifiers()),
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
    ), getterMemberRange)

    const result: ts.ClassElement[] = [
        backingProperty,
        getter
    ]

    if (!isReadonly) {
        const valueParameter = preserveTextRange(tsInstance, factory.createParameterDeclaration(
            undefined,
            undefined,
            preserveTextRange(tsInstance, factory.createIdentifier("value"), zeroWidthRange(nameEnd)),
            undefined,
            property.type
        ), zeroWidthRange(nameEnd))
        const setterParameters = preserveTextRange(tsInstance, factory.createNodeArray([ valueParameter ]), zeroWidthRange(nameEnd))
        const setter = preserveTextRange(tsInstance, factory.createSetAccessorDeclaration(
            createAccessorModifiers(),
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

function moveModifierTextRanges(
    tsInstance: TypeScript,
    modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
    range: ts.TextRange
): ts.NodeArray<ts.ModifierLike> | undefined {
    if (modifiers === undefined) {
        return undefined
    }

    return preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(modifiers.map((modifier) => {
        if (tsInstance.isDecorator(modifier)) {
            return modifier
        }

        return preserveTextRange(tsInstance, tsInstance.factory.createModifier(
            modifier.kind as ts.ModifierSyntaxKind
        ), range)
    })), range)
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
    // Rename/references treat synthesized nodes as non-source even when ranges are real.
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

function hasLazyPropertyInSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): boolean {
    const visit = (node: ts.Node): true | undefined => {
        if (
            (tsInstance.isClassDeclaration(node) || tsInstance.isClassExpression(node)) &&
            hasOwnLazyProperty(tsInstance, node, lazyDecoratorImports, options)
        ) {
            return true
        }

        return tsInstance.forEachChild(node, visit)
    }

    return tsInstance.forEachChild(sourceFile, visit) === true
}

function hasOwnLazyProperty(
    tsInstance: TypeScript,
    node: ts.ClassDeclaration | ts.ClassExpression,
    lazyDecoratorImports: LazyDecoratorImports,
    options: TransformOptions
): boolean {
    return node.members.some((member) => {
        return isLazyProperty(tsInstance, member, lazyDecoratorImports, options)
    })
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

function setCachedSourceFile(
    sourceCache: WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>,
    sourceFile: ts.SourceFile,
    cacheKey: string,
    cachedSourceFile: ts.SourceFile
): void {
    const cachedByOptions = sourceCache.get(sourceFile) ?? new Map<string, ts.SourceFile>()

    cachedByOptions.set(cacheKey, cachedSourceFile)
    sourceCache.set(sourceFile, cachedByOptions)
}

function shouldSkipSourceFile(sourceFile: ts.SourceFile): boolean {
    return sourceFile.isDeclarationFile || shouldSkipFileName(sourceFile.fileName)
}

function resolveUsePrintedSourceFile(
    config: LazyPropertyTransformerConfig,
    compilerOptions: ts.CompilerOptions
): boolean {
    const mode = config.mode

    if (mode === undefined) {
        return shouldCreatePrintedSourceFileForEmit(compilerOptions)
    }

    if (mode !== "emit" && mode !== "ide") {
        throw new Error(`ts-lazy-property: unknown "mode" option ${JSON.stringify(mode)}, expected "emit" or "ide".`)
    }

    return mode === "emit"
}

function shouldCreatePrintedSourceFileForEmit(compilerOptions: ts.CompilerOptions): boolean {
    return !compilerOptions.noEmit && !isTypeScriptServerProcess()
}

function preserveSourceCacheKey(
    options: TransformOptions,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): string {
    const languageVersionKey = typeof languageVersionOrOptions === "object"
        ? [
            languageVersionOrOptions.languageVersion,
            languageVersionOrOptions.impliedNodeFormat ?? "",
            languageVersionOrOptions.jsDocParsingMode ?? ""
        ].join(":")
        : String(languageVersionOrOptions)

    return [
        options.packageName,
        options.decoratorName,
        options.backingPrefix,
        languageVersionKey
    ].join("|")
}

function isTypeScriptServerProcess(): boolean {
    const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? []

    return argv.some((argument) => {
        const fileName = argument.replaceAll("\\", "/").split("/").at(-1)

        return fileName === "tsserver.js" || fileName === "_tsserver.js"
    })
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
