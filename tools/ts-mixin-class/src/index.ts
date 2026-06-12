import path from "node:path"
import type * as ts from "typescript"
import type { PluginConfig, ProgramTransformerExtras } from "ts-patch"

type TypeScript = ProgramTransformerExtras["ts"]
type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}
type NodeFactoryWithCloneNode = ts.NodeFactory & {
    cloneNode<Node extends ts.Node>(node: Node): Node
}

export type MixinClassTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string,
    mode? : MixinClassTransformerMode,
    staticCollisionCheck? : StaticCollisionCheckMode | boolean,
    constructionConfig? : ConstructionConfigMode
}

export type MixinClassTransformerMode = "emit" | "ide"
export type StaticCollisionCheckMode = false | "never" | "strict"
export type ConstructionConfigMode = "public-only" | "instance-type"

type TransformOptions = {
    packageName : string,
    decoratorName : string,
    sourceView : boolean,
    staticCollisionCheck : StaticCollisionCheckMode,
    constructionConfig : ConstructionConfigMode
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
    defaultExport : boolean,
    // ключи реестра зависимостей (mixin-записи из implements)
    dependencies : string[],
    requiredBaseName : string | undefined,
    configPropertyNames : string[]
}

export type MixinRegistry = Map<string, RegisteredMixin>

export type CrossFileContext = {
    registry : MixinRegistry,
    resolveModuleFileName : (specifier: string, containingFile: string) => string | undefined
    canImportRuntimeValue? : (resolvedFileName: string) => boolean
}

type ImportedNameBinding = {
    resolvedFileName : string,
    importedName     : string,
    typeOnly         : boolean
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
    requiredBase     : {
        localName : string,
        import    : { specifier: string, importedName: string, localName: string } | undefined
    } | undefined,
    dependencies     : string[],
    declaration      : ts.ClassDeclaration | undefined
    configPropertyNames : string[]
    missingRuntimeImport : {
        specifier : string,
        importedName : string
    } | undefined
}

type FileMixinContext = {
    byLocalName : Map<string, ResolvedMixinRef>,
    byKey       : Map<string, ResolvedMixinRef>,
    // фабрики, реально использованные в сгенерированных цепочках
    usedFactoryImports : Map<string, { specifier: string, importedName: string, localName: string }>
}

type RequiredBaseValidation = {
    typeParameter : ts.TypeParameterDeclaration,
    typeArgument  : ts.TypeNode
}

type RequiredBaseRequirement = {
    typeNode : ts.TypeNode,
    name     : string
}

type StaticSource = {
    name : string,
    typeNode : ts.TypeNode,
    staticNames : Set<string> | undefined
}

type MixinDeclarationDiagnostic = {
    node    : ts.Node,
    message : string
}

class DependencyLinearizationError extends Error {
    constructor(readonly pendingSequences: readonly string[][]) {
        super("Cannot linearize mixin classes: inconsistent requirements")
    }
}

const defaultTransformOptions: TransformOptions = {
    packageName          : "ts-mixin-class",
    decoratorName        : "mixin",
    sourceView           : false,
    staticCollisionCheck : "never",
    constructionConfig   : "public-only"
}

const anyConstructorName = "AnyConstructor"
const classStaticsName   = "ClassStatics"
const defineMixinClassName = "defineMixinClass"
const mixinChainName = "mixinChain"
const mixinFactoryName = "MixinFactory"
const runtimeMixinClassName = "RuntimeMixinClass"
const staticNeverConflictKeysName = "StaticNeverConflictKeys"
const staticStrictConflictKeysName = "StaticStrictConflictKeys"
const metadataBaseImportName = "base"
const metadataBaseLocalName = "__mixinBase"
const mixinFactorySuffix = "$mixin"
const consumerBaseSuffix = "$base"
const consumerEmptyBaseSuffix = "$empty"
const mixinValueSuffix = "$mixinValue"

function generatedName(name: string, suffix: string): string {
    return `__${name}${suffix}`
}

// ---------------------------------------------------------------------------
// Runtime/типовая поверхность пакета, используемая сгенерированным кодом

export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

export type ClassStatics<C> = Omit<C, "prototype">

export type NonFunctionPropertyNames<T> = {
    [Key in keyof T]: T[Key] extends (...args: any[]) => any ? never : Key
}[keyof T]

export type Config<T> = Partial<Pick<T, NonFunctionPropertyNames<T>>>

export type StaticNeverConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] & ClassStatics<Right>[Key] ] extends [ never ]
            ? Key
            : never
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type StaticStrictConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] ] extends [ ClassStatics<Right>[Key] ]
            ? [ ClassStatics<Right>[Key] ] extends [ ClassStatics<Left>[Key] ]
                ? never
                : Key
            : Key
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type MixinFactory = (base: AnyConstructor<any>) => AnyConstructor<any>

export class Base {
    initialize(props?: Config<this>): void {
        if (props !== undefined) {
            Object.assign(this, props)
        }
    }

    static new<T extends typeof Base>(this: T, props?: Config<InstanceType<T>>): InstanceType<T> {
        const instance = new this() as InstanceType<T>

        instance.initialize(props)

        return instance
    }

}

export const factory: unique symbol = Symbol.for("ts-mixin-class.factory") as any
export const requirements: unique symbol = Symbol.for("ts-mixin-class.requirements") as any
export const base: unique symbol = Symbol.for("ts-mixin-class.base") as any

export type RuntimeMixinClass<RequiredBase extends object = object> = {
    readonly [factory]: MixinFactory,
    readonly [requirements]: readonly RuntimeMixinClass[],
    readonly [base]: AnyConstructor<RequiredBase>
}

type RuntimeMixinClassValue = AnyConstructor<any> & RuntimeMixinClass

type RuntimeMixinMetadata = {
    factory: MixinFactory,
    requirements: RuntimeMixinClassValue[],
    requiredBase: AnyConstructor<any>,
    linearization: RuntimeMixinClassValue[] | undefined,
    applications: WeakMap<AnyConstructor<any>, AnyConstructor<any>>
}

const runtimeMixinMetadata = new WeakMap<RuntimeMixinClassValue, RuntimeMixinMetadata>()
const appliedMixinClasses = new WeakMap<AnyConstructor<any>, Set<RuntimeMixinClassValue>>()

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

export function defineMixinClass(
    name: string,
    mixinFactory: MixinFactory,
    mixinRequirements: readonly RuntimeMixinClassValue[] = [],
    requiredBase: AnyConstructor<any> = Object
): RuntimeMixinClassValue {
    const requirementList = [ ...mixinRequirements ]
    const requirementLinearization = linearizeRuntimeRequirements(requirementList)
    const canonicalBase = applyRuntimeMixins(requiredBase, requirementLinearization.slice().reverse())
    const mixinClass = mixinFactory(canonicalBase) as RuntimeMixinClassValue
    const applications = new WeakMap<AnyConstructor<any>, AnyConstructor<any>>()

    applications.set(canonicalBase, mixinClass)

    runtimeMixinMetadata.set(mixinClass, {
        factory        : mixinFactory,
        requirements   : requirementList,
        requiredBase,
        linearization  : [ mixinClass, ...requirementLinearization ],
        applications
    })

    Object.defineProperty(mixinClass, factory, { value : mixinFactory })
    Object.defineProperty(mixinClass, requirements, { value : requirementList })
    Object.defineProperty(mixinClass, base, { value : requiredBase })
    Object.defineProperty(mixinClass, Symbol.hasInstance, {
        value(instance: unknown) {
            return hasRuntimeMixinInstance(instance, mixinClass)
        }
    })

    setClassName(mixinClass, name)
    registerAppliedMixins(mixinClass, [ mixinClass, ...requirementLinearization ])

    return mixinClass
}

export function mixinChain<Base extends AnyConstructor<any>>(
    base: Base,
    ...mixins: RuntimeMixinClassValue[]
): AnyConstructor<any> {
    return applyRuntimeMixins(base, linearizeRuntimeRequirements(mixins).slice().reverse())
}

function applyRuntimeMixins(
    base: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): AnyConstructor<any> {
    let current = base

    for (const mixinClass of mixins) {
        current = applyRuntimeMixin(current, mixinClass)
    }

    return current
}

function applyRuntimeMixin(
    base: AnyConstructor<any>,
    mixinClass: RuntimeMixinClassValue
): AnyConstructor<any> {
    const metadata = runtimeMetadataOf(mixinClass)
    const cached = metadata.applications.get(base)

    if (!classExtends(base, metadata.requiredBase)) {
        throw new Error(
            `Mixin class ${mixinClass.name || "<anonymous>"} requires base ` +
            `${metadata.requiredBase.name || "<anonymous>"}`
        )
    }

    if (cached !== undefined) {
        return cached
    }

    const appliedClass = metadata.factory(base)

    metadata.applications.set(base, appliedClass)
    setClassName(appliedClass, mixinClass.name)
    registerAppliedMixins(appliedClass, [ mixinClass, ...linearizeRuntimeMixin(mixinClass).slice(1) ])

    return appliedClass
}

function linearizeRuntimeMixin(mixinClass: RuntimeMixinClassValue): RuntimeMixinClassValue[] {
    const metadata = runtimeMetadataOf(mixinClass)

    if (metadata.linearization !== undefined) {
        return metadata.linearization
    }

    metadata.linearization = [
        mixinClass,
        ...linearizeRuntimeRequirements(metadata.requirements)
    ]

    return metadata.linearization
}

function linearizeRuntimeRequirements(
    mixins: readonly RuntimeMixinClassValue[]
): RuntimeMixinClassValue[] {
    if (mixins.length === 0) {
        return []
    }

    return mergeRuntimeLinearizations([
        ...mixins.map((mixinClass) => [ ...linearizeRuntimeMixin(mixinClass) ]),
        [ ...mixins ]
    ])
}

function mergeRuntimeLinearizations(sequences: RuntimeMixinClassValue[][]): RuntimeMixinClassValue[] {
    const result: RuntimeMixinClassValue[] = []
    const pending = sequences
        .map((sequence) => sequence.filter((mixinClass, index) => sequence.indexOf(mixinClass) === index))
        .filter((sequence) => sequence.length > 0)

    while (pending.length > 0) {
        const candidate = pending
            .map((sequence) => sequence[0])
            .find((head) => {
                return pending.every((sequence) => !sequence.slice(1).includes(head))
            })

        if (candidate === undefined) {
            throw new Error("Cannot linearize mixin classes: inconsistent requirements")
        }

        result.push(candidate)

        for (let index = pending.length - 1; index >= 0; index--) {
            if (pending[index][0] === candidate) {
                pending[index].shift()
            }

            if (pending[index].length === 0) {
                pending.splice(index, 1)
            }
        }
    }

    return result
}

function runtimeMetadataOf(mixinClass: RuntimeMixinClassValue): RuntimeMixinMetadata {
    const metadata = runtimeMixinMetadata.get(mixinClass)

    if (metadata === undefined) {
        throw new Error(`Class ${mixinClass.name || "<anonymous>"} is not a registered mixin class`)
    }

    return metadata
}

function classExtends(base: AnyConstructor<any>, requiredBase: AnyConstructor<any>): boolean {
    return requiredBase === Object ||
        base === requiredBase ||
        requiredBase.prototype.isPrototypeOf(base.prototype)
}

function registerAppliedMixins(
    appliedClass: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): void {
    const inherited = appliedMixinClasses.get(Object.getPrototypeOf(appliedClass)) ?? new Set<RuntimeMixinClassValue>()
    const applied = new Set<RuntimeMixinClassValue>(inherited)

    for (const mixinClass of mixins) {
        applied.add(mixinClass)
    }

    appliedMixinClasses.set(appliedClass, applied)
}

function hasRuntimeMixinInstance(instance: unknown, mixinClass: RuntimeMixinClassValue): boolean {
    if (instance === null || typeof instance !== "object" && typeof instance !== "function") {
        return false
    }

    let constructor = (instance as { constructor?: unknown }).constructor

    while (typeof constructor === "function") {
        if (appliedMixinClasses.get(constructor as AnyConstructor<any>)?.has(mixinClass)) {
            return true
        }

        constructor = Object.getPrototypeOf(constructor)
    }

    return false
}

function setClassName(classConstructor: AnyConstructor<any>, name: string): void {
    if (name.length === 0) {
        return
    }

    Object.defineProperty(classConstructor, "name", {
        configurable : true,
        value        : name
    })
}

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

function preserveTopLevelStatementRanges(tsInstance: TypeScript, sourceFile: ts.SourceFile): void {
    let previousEnd = 0

    for (const statement of sourceFile.statements) {
        const descendantRange = realDescendantRange(tsInstance, statement)

        if (statement.pos < 0 || statement.end < 0) {
            tsInstance.setTextRange(
                statement,
                descendantRange ?? generatedTextRange(sourceFile, previousEnd)
            )
        } else if (descendantRange !== undefined) {
            tsInstance.setTextRange(statement, {
                pos : Math.min(statement.pos, descendantRange.pos),
                end : Math.max(statement.end, descendantRange.end)
            })
        }

        if (statement.end >= 0) {
            previousEnd = statement.end
        }
    }

    const first = sourceFile.statements[0]
    const last  = sourceFile.statements.at(-1)

    if (first !== undefined && last !== undefined) {
        tsInstance.setTextRange(sourceFile.statements, {
            pos : Math.max(0, first.pos),
            end : Math.max(first.end, last.end)
        })
    }

    preserveSyntheticDescendantRanges(tsInstance, sourceFile, generatedTextRange(sourceFile, 0))
}

function realDescendantRange(tsInstance: TypeScript, node: ts.Node): ts.TextRange | undefined {
    let range: ts.TextRange | undefined

    const visit = (child: ts.Node): void => {
        if (child.pos >= 0 && child.end >= 0) {
            range = range === undefined
                ? { pos : child.pos, end : child.end }
                : {
                    pos : Math.min(range.pos, child.pos),
                    end : Math.max(range.end, child.end)
                }
        }

        tsInstance.forEachChild(child, visit)
    }

    tsInstance.forEachChild(node, visit)

    return range
}

function zeroWidthRange(position: number): ts.TextRange {
    return {
        pos : position,
        end : position
    }
}

function generatedTextRange(sourceFile: ts.SourceFile, position: number): ts.TextRange {
    if (sourceFile.text.length === 0) {
        return zeroWidthRange(0)
    }

    const pos = generatedTextPosition(sourceFile.text, position)

    return {
        pos,
        end : pos + 1
    }
}

function generatedTextPosition(text: string, position: number): number {
    const initialPosition = Math.min(Math.max(0, position), text.length - 1)

    if (!isLineBreak(text[initialPosition])) {
        return initialPosition
    }

    for (let index = initialPosition - 1; index >= 0; index--) {
        if (!isLineBreak(text[index])) {
            return index
        }
    }

    for (let index = initialPosition + 1; index < text.length; index++) {
        if (!isLineBreak(text[index])) {
            return index
        }
    }

    return initialPosition
}

function isLineBreak(char: string | undefined): boolean {
    return char === "\n" || char === "\r"
}

function preserveSyntheticDescendantRanges(
    tsInstance: TypeScript,
    node: ts.Node,
    parentRange: ts.TextRange
): void {
    const currentRange = node.pos >= 0 && node.end >= 0
        ? {
            pos : node.pos,
            end : node.end
        }
        : parentRange

    if (node.pos < 0 || node.end < 0) {
        tsInstance.setTextRange(node, currentRange)
    }

    tsInstance.forEachChild(node, (child) => {
        preserveSyntheticDescendantRanges(tsInstance, child, currentRange)
    })
}

function preserveTextRange<Range extends ts.TextRange>(
    tsInstance: TypeScript,
    range: Range,
    original: ts.TextRange
): Range {
    tsInstance.setTextRange(range, original)

    return range
}

function preserveGeneratedDeclarationRange<Node extends ts.Node>(
    tsInstance: TypeScript,
    node: Node,
    range: ts.TextRange,
    original: ts.Node
): Node {
    tsInstance.setOriginalNode(node, original)
    preserveGeneratedOriginalNodes(tsInstance, node, original)

    return preserveTextRange(tsInstance, node, range)
}

function preserveSourceViewGeneratedClassLikeRange<
    Node extends ts.ClassDeclaration | ts.InterfaceDeclaration
>(
    tsInstance: TypeScript,
    node: Node,
    original: ts.ClassDeclaration
): Node {
    tsInstance.setOriginalNode(node, original)
    preserveGeneratedOriginalNodes(tsInstance, node, original)
    preserveTextRange(tsInstance, node, original)
    preserveTextRange(tsInstance, node, {
        pos : original.pos,
        end : original.members.pos
    })

    if (node.name !== undefined && original.name !== undefined) {
        preserveTextRange(tsInstance, node.name, {
            pos : original.pos,
            end : original.name.end
        })
    }

    if (node.typeParameters !== undefined) {
        const generatedTypeParameterRange = zeroWidthRange(original.typeParameters?.end ?? original.name?.end ?? original.end)

        preserveTextRange(tsInstance, node.typeParameters, original.typeParameters ?? generatedTypeParameterRange)

        node.typeParameters.forEach((typeParameter, index) => {
            const originalTypeParameter = original.typeParameters?.[index]

            if (originalTypeParameter !== undefined) {
                preserveTextRange(tsInstance, typeParameter, originalTypeParameter)
                preserveTextRange(tsInstance, typeParameter.name, originalTypeParameter.name)
            } else {
                preserveSubtreeTextRange(
                    tsInstance,
                    typeParameter,
                    generatedTypeParameterRange
                )
            }
        })
    }

    if (node.heritageClauses !== undefined) {
        const originalHeritage = original.heritageClauses
        const originalHeritageTypes = originalHeritage?.flatMap((heritageClause) => [ ...heritageClause.types ]) ?? []
        const originalHeritageRange = originalHeritage === undefined
            ? zeroWidthRange(original.name?.end ?? original.end)
            : { pos : originalHeritage.pos, end : originalHeritage.end }
        let generatedHeritageRange: ts.TextRange | undefined

        preserveTextRange(tsInstance, node.heritageClauses, originalHeritageRange)

        node.heritageClauses.forEach((heritageClause, index) => {
            const originalClause = originalHeritage?.[Math.min(index, originalHeritage.length - 1)]
            const clauseRange = originalClause ?? originalHeritageRange
            const mappedOriginalTypes = heritageClause.types.map((_heritageType, typeIndex) => {
                return originalHeritageTypes[typeIndex] ??
                    originalClause?.types[Math.min(typeIndex, originalClause.types.length - 1)]
            })
            const mappedOriginalTypesWithRanges = mappedOriginalTypes.filter((type): type is ts.ExpressionWithTypeArguments => {
                return type !== undefined
            })

            const heritageTypesRange = mappedOriginalTypesWithRanges.length === 0
                ? clauseRange
                : {
                    pos : mappedOriginalTypesWithRanges[0].pos,
                    end : mappedOriginalTypesWithRanges.at(-1)!.end
                }

            const nextHeritageRange = {
                pos : clauseRange.pos,
                end : heritageTypesRange.end
            }

            generatedHeritageRange = generatedHeritageRange === undefined
                ? nextHeritageRange
                : {
                    pos : Math.min(generatedHeritageRange.pos, nextHeritageRange.pos),
                    end : Math.max(generatedHeritageRange.end, nextHeritageRange.end)
                }

            preserveTextRange(tsInstance, heritageClause, nextHeritageRange)
            preserveTextRange(tsInstance, heritageClause.types, heritageTypesRange)

            heritageClause.types.forEach((heritageType, typeIndex) => {
                const originalType = mappedOriginalTypes[typeIndex]
                const typeRange = originalType ?? clauseRange

                preserveTextRange(tsInstance, heritageType, typeRange)
                preserveTextRange(tsInstance, heritageType.expression, originalType?.expression ?? typeRange)

                if (heritageType.typeArguments !== undefined) {
                    const originalTypeArguments = originalType?.typeArguments
                    const generatedTypeArgumentRange = zeroWidthRange(heritageType.expression.end)

                    preserveTextRange(
                        tsInstance,
                        heritageType.typeArguments,
                        originalTypeArguments ?? generatedTypeArgumentRange
                    )

                    heritageType.typeArguments.forEach((typeArgument, argumentIndex) => {
                        preserveSubtreeTextRange(
                            tsInstance,
                            typeArgument,
                            originalTypeArguments?.[argumentIndex] ?? generatedTypeArgumentRange
                        )
                    })
                }
            })
        })

        if (generatedHeritageRange !== undefined) {
            preserveTextRange(tsInstance, node.heritageClauses, generatedHeritageRange)
        }
    }

    if ("members" in node) {
        const generatedHeaderEnd = node.heritageClauses?.end ?? node.typeParameters?.end ?? node.name?.end ?? original.members.pos

        preserveTextRange(tsInstance, node.members, node.members.length === 0
            ? zeroWidthRange(generatedHeaderEnd)
            : original.members
        )

        if (node.members.length === 0) {
            preserveTextRange(tsInstance, node, {
                pos : node.pos,
                end : generatedHeaderEnd
            })
        }
    }

    return node
}

function preserveSubtreeTextRange(
    tsInstance: TypeScript,
    node: ts.Node,
    range: ts.TextRange
): void {
    preserveTextRange(tsInstance, node, range)

    tsInstance.forEachChild(node, (child) => {
        preserveSubtreeTextRange(tsInstance, child, range)
    })
}

function preserveGeneratedOriginalNodes(
    tsInstance: TypeScript,
    node: ts.Node,
    original: ts.Node
): void {
    tsInstance.forEachChild(node, (child) => {
        if (tsInstance.getParseTreeNode(child) === undefined) {
            tsInstance.setOriginalNode(child, original)
        }

        preserveGeneratedOriginalNodes(tsInstance, child, original)
    })
}

function cloneSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): ts.SourceFile {
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

function setParentRecursivePreservingVersion(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    originalSourceFile: ts.SourceFile
): ts.SourceFile {
    ;(sourceFile as SourceFileWithVersion).version = (originalSourceFile as SourceFileWithVersion).version

    return (tsInstance as TypeScriptWithParents).setParentRecursive(sourceFile, false)
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

    const candidates: Candidate[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (shouldSkipRegistrySourceFile(sourceFile)) {
            continue
        }

        if (sourceFile.isDeclarationFile) {
            candidates.push(...collectDeclarationFileMixinCandidates(tsInstance, sourceFile))
            continue
        }

        if (!sourceFile.text.includes(resolvedOptions.packageName)) {
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
                name                 : statement.name.text,
                dependencyNames      : implementsTypes(tsInstance, statement)
                    .map((heritageType) => heritageType.expression)
                    .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
                    .map((expression) => expression.text),
                requiredBaseName     : requiredBaseIdentifierName(tsInstance, statement),
                configPropertyNames  : instanceConfigPropertyNames(tsInstance, statement, true),
                declarationHeritage  : false,
                defaultExport        : hasModifier(tsInstance, statement, tsInstance.SyntaxKind.DefaultKeyword)
            })
        }
    }

    const registry: MixinRegistry = new Map()

    for (const candidate of candidates) {
        registry.set(registryKey(candidate.sourceFile.fileName, candidate.name), {
            fileName          : candidate.sourceFile.fileName,
            name              : candidate.name,
            defaultExport     : candidate.defaultExport,
            dependencies      : [],
            requiredBaseName  : candidate.requiredBaseName,
            configPropertyNames : candidate.configPropertyNames
        })

        if (candidate.defaultExport) {
            registry.set(registryKey(candidate.sourceFile.fileName, "default"), registry.get(
                registryKey(candidate.sourceFile.fileName, candidate.name)
            )!)
        }
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

        for (const dependencyName of candidate.dependencyNames) {
            const sameFileKey = registryKey(fileName, dependencyName)

            if (registry.has(sameFileKey)) {
                entry.dependencies.push(sameFileKey)
                continue
            }

            const imported = importMap.get(dependencyName)

            if (imported !== undefined) {
                const importedKey = registryKey(imported.resolvedFileName, imported.importedName)

                if (registry.has(importedKey)) {
                    entry.dependencies.push(importedKey)
                    continue
                }
            }

            if (candidate.declarationHeritage && entry.requiredBaseName === undefined) {
                entry.requiredBaseName = dependencyName
            }
        }
    }

    return registry
}

type Candidate = {
    sourceFile           : ts.SourceFile,
    name                 : string,
    dependencyNames      : string[],
    requiredBaseName     : string | undefined,
    configPropertyNames  : string[],
    declarationHeritage  : boolean,
    defaultExport        : boolean
}

function shouldSkipRegistrySourceFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) {
        return !/\.[cm]?tsx?$/.test(normalizePath(sourceFile.fileName))
    }

    return shouldSkipFileName(sourceFile.fileName)
}

function collectDeclarationFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Candidate[] {
    const candidates: Candidate[] = []
    const interfaces = new Map<string, ts.InterfaceDeclaration>()
    const defaultExportNames = new Set<string>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isInterfaceDeclaration(statement)) {
            interfaces.set(statement.name.text, statement)
            continue
        }

        if (tsInstance.isExportAssignment(statement) && tsInstance.isIdentifier(statement.expression)) {
            defaultExportNames.add(statement.expression.text)
        }
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isVariableStatement(statement)) {
            continue
        }

        const exportedStatement = hasModifier(tsInstance, statement, tsInstance.SyntaxKind.ExportKeyword)

        for (const declaration of statement.declarationList.declarations) {
            if (!tsInstance.isIdentifier(declaration.name) ||
                declaration.type === undefined ||
                !typeReferencesRuntimeMixinClass(tsInstance, declaration.type)
            ) {
                continue
            }

            const defaultExport = defaultExportNames.has(declaration.name.text)

            if (!exportedStatement && !defaultExport) {
                continue
            }

            candidates.push({
                sourceFile,
                name                 : declaration.name.text,
                dependencyNames      : interfaceExtendsNames(tsInstance, interfaces.get(declaration.name.text)),
                requiredBaseName     : undefined,
                configPropertyNames  : interfaceConfigPropertyNames(tsInstance, interfaces.get(declaration.name.text)),
                declarationHeritage  : true,
                defaultExport
            })
        }
    }

    return candidates
}

function typeReferencesRuntimeMixinClass(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
    if (tsInstance.isTypeReferenceNode(typeNode) &&
        tsInstance.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === runtimeMixinClassName
    ) {
        return true
    }

    if (tsInstance.isIntersectionTypeNode(typeNode) || tsInstance.isUnionTypeNode(typeNode)) {
        return typeNode.types.some((type) => typeReferencesRuntimeMixinClass(tsInstance, type))
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return typeReferencesRuntimeMixinClass(tsInstance, typeNode.type)
    }

    return false
}

function interfaceExtendsNames(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): string[] {
    const clause = declaration?.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })

    if (clause === undefined) {
        return []
    }

    return clause.types
        .map((heritageType) => heritageType.expression)
        .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
        .map((expression) => expression.text)
}

function interfaceConfigPropertyNames(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): string[] {
    if (declaration === undefined) {
        return []
    }

    return uniqueStrings(declaration.members
        .filter((member): member is ts.PropertySignature => {
            return tsInstance.isPropertySignature(member) && member.name !== undefined
        })
        .map((member) => propertyNameText(tsInstance, member.name))
        .filter((name): name is string => name !== undefined)
    )
}

function instanceConfigPropertyNames(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    requirePublicModifier = false
): string[] {
    return uniqueStrings(declaration.members
        .filter((member): member is ts.PropertyDeclaration => {
            return tsInstance.isPropertyDeclaration(member) &&
                !hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
                !hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) &&
                !hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) &&
                (!requirePublicModifier || hasModifier(tsInstance, member, tsInstance.SyntaxKind.PublicKeyword))
        })
        .map((member) => propertyNameText(tsInstance, member.name))
        .filter((name): name is string => name !== undefined)
    )
}

function propertyNameText(tsInstance: TypeScript, name: ts.PropertyName): string | undefined {
    if (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name) || tsInstance.isNumericLiteral(name)) {
        return name.text
    }

    return undefined
}

function uniqueStrings(values: string[]): string[] {
    return [ ...new Set(values) ]
}

function registryKey(fileName: string, name: string): string {
    return `${normalizePath(fileName)}::${name}`
}

function normalizePath(fileName: string): string {
    return fileName.replaceAll("\\", "/")
}

function hasRuntimeModuleForDeclaration(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    fileName: string
): boolean {
    if (!fileName.endsWith(".d.ts") && !fileName.endsWith(".d.mts") && !fileName.endsWith(".d.cts")) {
        return true
    }

    return runtimeModuleFileNames(fileName).some((runtimeFileName) => {
        return compilerHost.fileExists(runtimeFileName) ||
            tsInstance.sys.fileExists(runtimeFileName)
    })
}

function runtimeModuleFileNames(declarationFileName: string): string[] {
    if (declarationFileName.endsWith(".d.mts")) {
        return [
            declarationFileName.slice(0, -".d.mts".length) + ".mjs",
            declarationFileName.slice(0, -".d.mts".length) + ".js"
        ]
    }

    if (declarationFileName.endsWith(".d.cts")) {
        return [
            declarationFileName.slice(0, -".d.cts".length) + ".cjs",
            declarationFileName.slice(0, -".d.cts".length) + ".js"
        ]
    }

    return [
        declarationFileName.slice(0, -".d.ts".length) + ".js",
        declarationFileName.slice(0, -".d.ts".length) + ".mjs",
        declarationFileName.slice(0, -".d.ts".length) + ".cjs"
    ]
}

// localName -> откуда импортировано (только успешно разрешённые именованные импорты)
function buildImportedNameMap(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined
): Map<string, ImportedNameBinding> {
    const importMap = new Map<string, ImportedNameBinding>()

    if (resolveModuleFileName === undefined) {
        return importMap
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue
        }

        const importClause = statement.importClause
        const namedBindings = importClause?.namedBindings

        const resolvedFileName = resolveModuleFileName(statement.moduleSpecifier.text, sourceFile.fileName)

        if (resolvedFileName === undefined) {
            continue
        }

        if (importClause?.name !== undefined) {
            importMap.set(importClause.name.text, {
                resolvedFileName,
                importedName : "default",
                typeOnly     : importClause.isTypeOnly
            })
        }

        if (namedBindings === undefined || !tsInstance.isNamedImports(namedBindings)) {
            continue
        }

        for (const element of namedBindings.elements) {
            importMap.set(element.name.text, {
                resolvedFileName,
                importedName : element.propertyName?.text ?? element.name.text,
                typeOnly     : importClause?.isTypeOnly === true || element.isTypeOnly
            })
        }
    }

    return importMap
}

function importedRequiredBaseRef(
    importMap: Map<string, ImportedNameBinding>,
    resolvedFileName: string,
    specifier: string,
    importedName: string,
    fallbackLocalName: string
): ResolvedMixinRef["requiredBase"] {
    for (const [ localName, imported ] of importMap) {
        if (imported.resolvedFileName === resolvedFileName && imported.importedName === importedName) {
            return {
                localName,
                import : undefined
            }
        }
    }

    return {
        localName : fallbackLocalName,
        import    : {
            specifier,
            importedName,
            localName : fallbackLocalName
        }
    }
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

// Сгенерированные импорты (хелперы типов + фабрики миксинов из других модулей)
// вставляются после последнего исходного импорта
function insertGeneratedImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    if (options.sourceView) {
        return statements
    }

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
                continue
            }

            const name = statement.name.text
            const ref: ResolvedMixinRef = {
                key              : registryKey(sourceFile.fileName, name),
                className        : name,
                localValueName   : name,
                localFactoryName : generatedName(name, mixinFactorySuffix),
                factoryImport    : undefined,
                requiredBase     : undefined,
                dependencies     : [],
                declaration      : statement,
                configPropertyNames : instanceConfigPropertyNames(tsInstance, statement, true),
                missingRuntimeImport : undefined
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

            const importClause = statement.importClause
            const namedBindings = importClause?.namedBindings
            const localNames = [
                ...(importClause?.name === undefined ? [] : [ importClause.name.text ]),
                ...(namedBindings !== undefined && tsInstance.isNamedImports(namedBindings)
                    ? namedBindings.elements.map((element) => element.name.text)
                    : [])
            ]

            if (localNames.length === 0) {
                continue
            }

            for (const localName of localNames) {
                const imported  = importMap.get(localName)

                if (imported === undefined || context.byLocalName.has(localName)) {
                    continue
                }

                const key        = registryKey(imported.resolvedFileName, imported.importedName)
                const registered = crossFile.registry.get(key)

                if (registered === undefined) {
                    continue
                }
                const localValueName = imported.typeOnly ? generatedName(localName, mixinValueSuffix) : localName

                if (imported.typeOnly) {
                    const importedValueName = registered.defaultExport ? "default" : registered.name

                    context.usedFactoryImports.set(
                        `${statement.moduleSpecifier.text}:${importedValueName}:${localValueName}`,
                        {
                            specifier    : statement.moduleSpecifier.text,
                            importedName : importedValueName,
                            localName    : localValueName
                        }
                    )
                }

                const requiredBase = registered.requiredBaseName === undefined
                    ? undefined
                    : importedRequiredBaseRef(
                        importMap,
                        imported.resolvedFileName,
                        statement.moduleSpecifier.text,
                        registered.requiredBaseName,
                        localName + "$requiredBase"
                    )

                const ref: ResolvedMixinRef = {
                    key,
                    className        : registered.name,
                    localValueName,
                    localFactoryName : generatedName(localName, mixinFactorySuffix),
                    factoryImport    : {
                        specifier    : statement.moduleSpecifier.text,
                        importedName : generatedName(registered.name, mixinFactorySuffix)
                    },
                    requiredBase,
                    dependencies     : registered.dependencies,
                    declaration      : undefined,
                    configPropertyNames : registered.configPropertyNames,
                    missingRuntimeImport : crossFile.canImportRuntimeValue?.(registered.fileName) === false
                        ? {
                            specifier    : statement.moduleSpecifier.text,
                            importedName : registered.defaultExport ? "default" : registered.name
                        }
                        : undefined
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
                localFactoryName : generatedName(registered.name, mixinFactorySuffix),
                factoryImport    : {
                    specifier    : relativeImportSpecifier(sourceFile.fileName, registered.fileName),
                    importedName : generatedName(registered.name, mixinFactorySuffix)
                },
                requiredBase     : registered.requiredBaseName === undefined
                    ? undefined
                    : {
                        localName : registered.name + "$requiredBase",
                        import    : {
                            specifier    : relativeImportSpecifier(sourceFile.fileName, registered.fileName),
                            importedName : registered.requiredBaseName,
                            localName    : registered.name + "$requiredBase"
                        }
                },
                dependencies     : registered.dependencies,
                declaration      : undefined,
                configPropertyNames : registered.configPropertyNames,
                missingRuntimeImport : crossFile.canImportRuntimeValue?.(registered.fileName) === false
                    ? {
                        specifier    : relativeImportSpecifier(sourceFile.fileName, registered.fileName),
                        importedName : registered.defaultExport ? "default" : registered.name
                    }
                    : undefined
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
// Трансформация mixin-класса
//
// Mixin-класс разворачивается в три декларации (см. SPEC.md):
//
//     interface X<T> { ...сигнатуры инстанс-членов... }
//     const __X$mixin = <T>(base: AnyConstructor) => class extends base { ...тело... }
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

    if (dependencyHeritage.length === 0) {
        return [ declaration ]
    }

    const baseName       = generatedName(declaration.name.text, consumerBaseSuffix)
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const generatedRange = generatedTextRange(sourceFile, declaration.pos)
    const generatedHeritageRange = generatedTextRange(sourceFile, declaration.heritageClauses?.pos ?? declaration.name.end)

    const baseInterface = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        typeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
                ...dependencyHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ]
        ) ],
        []
    ), declaration)

    const baseClassHeritage = [
        ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
        ...dependencyHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
    ]
    const baseClass = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        typeParameters,
        baseClassHeritage.length === 0
            ? undefined
            : [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ baseClassHeritage[0] ]) ],
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

// Параметр base фабрики: AnyConstructor, либо AnyConstructor<Dep1<...> & Dep2<...>>
// для миксина с зависимостями - это даёт типизированный super внутри тела
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
// Трансформация класса-потребителя
//
// Потребитель разворачивается в промежуточную базу с declaration merging (SPEC.md):
//
//     interface __X$base<A> extends Mixin1<...>, Mixin2<...> {}
//     class __X$base<A> extends (mixinChain(Base, Mixin1, Mixin2) as unknown as
//         typeof Base & ClassStatics<typeof Mixin1> & ClassStatics<typeof Mixin2>) {}
//     class X<A> extends __X$base<A> implements Mixin1<...>, Mixin2<...> { ...тело без изменений... }

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
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const generatedTypeParameters = cloneOptionalNodeArray(tsInstance, declaration.typeParameters)
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
    const emptyBaseName = !options.sourceView && extendsType === undefined && implicitRequiredBase === undefined
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
    const checkedTypeParameters = options.sourceView
        ? appendSourceViewValidationTypeParameters(tsInstance, declaration.typeParameters, consumerValidations)
        : appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            consumerValidations
        )

    const baseInterfaceNode = factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(extendsType?.typeArguments !== undefined ? [ cloneExpressionWithTypeArguments(tsInstance, extendsType) ] : []),
                ...(implicitRequiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, implicitRequiredBase) ]),
                ...mixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
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
        checkedTypeParameters,
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
        generatedRange
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
            ? preserveSourceViewGeneratedClassLikeRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
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
    if (options.sourceView ||
        declaration.name === undefined ||
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

    return [
        preserveGeneratedDeclarationRange(tsInstance, factory.createMethodDeclaration(
            staticModifier,
            undefined,
            "new",
            undefined,
            cloneOptionalNodeArray(tsInstance, declaration.typeParameters),
            [ factory.createParameterDeclaration(
                undefined,
                undefined,
                "props",
                factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                configType
            ) ],
            consumerType,
            undefined
        ), generatedRange, declaration),
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
        ), generatedRange, declaration),
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
        ), generatedRange, declaration)
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

    const propertyNames = staticConstructionConfigPropertyNames(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        mixinRefs
    )

    return factory.createTypeReferenceNode("Partial", [
        factory.createTypeReferenceNode("Pick", [
            createConsumerInstanceType(tsInstance, declaration),
            propertyNames.length === 0
                ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
                : propertyNames.length === 1
                    ? factory.createLiteralTypeNode(factory.createStringLiteral(propertyNames[0]))
                    : factory.createUnionTypeNode(propertyNames.map((propertyName) => {
                        return factory.createLiteralTypeNode(factory.createStringLiteral(propertyName))
                    }))
        ])
    ])
}

function staticConstructionConfigPropertyNames(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[]
): string[] {
    return uniqueStrings([
        ...baseConfigPropertyNames(tsInstance, sourceFile, extendsType ?? implicitRequiredBase),
        ...mixinRefs.flatMap((ref) => ref.configPropertyNames),
        ...instanceConfigPropertyNames(tsInstance, declaration, true)
    ])
}

function baseConfigPropertyNames(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined
): string[] {
    if (baseType === undefined || !tsInstance.isIdentifier(baseType.expression)) {
        return []
    }

    const baseName = baseType.expression.text
    const baseDeclaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === baseName
    })

    return baseDeclaration === undefined ? [] : instanceConfigPropertyNames(tsInstance, baseDeclaration, true)
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
            cloneExpressionWithTypeArguments(
                tsInstance,
                consumerRuntimeBaseType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName)
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
        cloneNode(tsInstance, expression.expression),
        cloneOptionalNodeArray(tsInstance, expression.typeArguments)
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
        ...(consumerTypeParameters ?? []),
        ...validations.map((validation) => cloneNode(tsInstance, validation.typeParameter))
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

// Каст runtime-цепочки: typeof Base (или typeof __X$empty без явной базы)
// плюс статика каждого применённого миксина, чьё значение доступно в файле
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
// Линеаризация и построение runtime-цепочки

function linearizeDependencies(
    dependencyKeys: string[],
    context: FileMixinContext
): ResolvedMixinRef[] {
    return linearizeDependencyKeys(dependencyKeys, context).map((key) => {
        return context.byKey.get(key)!
    })
}

function linearizeDependencyKeys(
    dependencyKeys: string[],
    context: FileMixinContext,
    cache: Map<string, string[]> = new Map()
): string[] {
    if (dependencyKeys.length === 0) {
        return []
    }

    return mergeDependencyLinearizations([
        ...dependencyKeys.map((key) => linearizeDependencyKey(key, context, cache)),
        [ ...dependencyKeys ]
    ])
}

function linearizeDependencyKey(
    key: string,
    context: FileMixinContext,
    cache: Map<string, string[]>
): string[] {
    const cached = cache.get(key)

    if (cached !== undefined) {
        return cached
    }

    const ref = context.byKey.get(key)

    if (ref === undefined) {
        return [ key ]
    }

    const linearized = [
        key,
        ...linearizeDependencyKeys(ref.dependencies, context, cache)
    ]

    cache.set(key, linearized)

    return linearized
}

function mergeDependencyLinearizations(sequences: string[][]): string[] {
    const result: string[] = []
    const pending = sequences
        .map((sequence) => sequence.filter((key, index) => sequence.indexOf(key) === index))
        .filter((sequence) => sequence.length > 0)

    while (pending.length > 0) {
        const candidate = pending
            .map((sequence) => sequence[0])
            .find((head) => {
                return pending.every((sequence) => !sequence.slice(1).includes(head))
            })

        if (candidate === undefined) {
            throw new DependencyLinearizationError(pending.map((sequence) => [ ...sequence ]))
        }

        result.push(candidate)

        for (let index = pending.length - 1; index >= 0; index--) {
            if (pending[index][0] === candidate) {
                pending[index].shift()
            }

            if (pending[index].length === 0) {
                pending.splice(index, 1)
            }
        }
    }

    return result
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

// ---------------------------------------------------------------------------
// Сигнатуры инстанс-членов для сгенерированного интерфейса

function buildInterfaceMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): ts.NodeArray<ts.TypeElement> {
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

        if (tsInstance.isConstructorDeclaration(member) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            continue
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            members.push(preserveTextRange(tsInstance, factory.createPropertySignature(
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                    : undefined,
                cloneNode(tsInstance, member.name),
                cloneOptionalNode(tsInstance, member.questionToken),
                cloneOptionalNode(tsInstance, member.type) ??
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            ), interfaceMemberRange(member)))
            continue
        }

        if (tsInstance.isMethodDeclaration(member)) {
            members.push(preserveTextRange(tsInstance, factory.createMethodSignature(
                undefined,
                cloneNode(tsInstance, member.name),
                cloneOptionalNode(tsInstance, member.questionToken),
                cloneOptionalNodeArray(tsInstance, member.typeParameters),
                member.parameters.map((parameter) => signatureParameter(tsInstance, sourceFile, parameter)),
                cloneOptionalNode(tsInstance, member.type) ??
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            ), interfaceMemberRange(member)))
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const name = memberNameText(tsInstance, sourceFile, member)

            if (emittedAccessors.has(name)) {
                continue
            }

            emittedAccessors.add(name)

            members.push(accessorSignature(tsInstance, sourceFile, member, getters.get(name), setters.get(name)))
            continue
        }

        continue
    }

    const membersRange = members.length === 0
        ? zeroWidthRange(declaration.name?.end ?? declaration.end)
        : {
            pos : members[0].pos,
            end : members.at(-1)!.end
        }

    return preserveTextRange(tsInstance, factory.createNodeArray(members), membersRange)
}

function interfaceDeclarationRange(
    declaration: ts.ClassDeclaration,
    members: ts.NodeArray<ts.TypeElement>
): ts.TextRange {
    return {
        pos : declaration.pos,
        end : Math.max(declaration.name?.end ?? declaration.end, members.end)
    }
}

function accessorSignature(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
    getter: ts.GetAccessorDeclaration | undefined,
    setter: ts.SetAccessorDeclaration | undefined
): ts.PropertySignature {
    const factory = tsInstance.factory

    const type =
        getter?.type ??
        (setter !== undefined && setter.parameters.length > 0 ? setter.parameters[0].type : undefined)

    return preserveTextRange(tsInstance, factory.createPropertySignature(
        setter === undefined ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ] : undefined,
        cloneNode(tsInstance, member.name),
        undefined,
        cloneOptionalNode(tsInstance, type) ??
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
    ), interfaceMemberRange(member))
}

function signatureParameter(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    parameter: ts.ParameterDeclaration
): ts.ParameterDeclaration {
    // у параметра с инициализатором в сигнатуре инициализатор заменяется опциональностью
    return preserveTextRange(tsInstance, tsInstance.factory.createParameterDeclaration(
        undefined,
        cloneOptionalNode(tsInstance, parameter.dotDotDotToken),
        cloneNode(tsInstance, parameter.name),
        parameter.initializer === undefined
            ? cloneOptionalNode(tsInstance, parameter.questionToken)
            : tsInstance.factory.createToken(tsInstance.SyntaxKind.QuestionToken),
        cloneOptionalNode(tsInstance, parameter.type) ??
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword),
        undefined
    ), parameterSignatureRange(parameter))
}

function interfaceMemberRange(member: ts.ClassElement): ts.TextRange {
    if (isTypedClassElement(member)) {
        return {
            pos : member.pos,
            end : member.type.end
        }
    }

    return {
        pos : member.pos,
        end : member.end
    }
}

function isTypedClassElement(member: ts.ClassElement): member is ts.ClassElement & { type: ts.TypeNode } {
    return "type" in member && member.type !== undefined
}

function parameterSignatureRange(parameter: ts.ParameterDeclaration): ts.TextRange {
    return {
        pos : parameter.pos,
        end : parameter.type?.end ?? parameter.name.end
    }
}

function cloneNode<Node extends ts.Node>(tsInstance: TypeScript, node: Node): Node {
    return (tsInstance.factory as NodeFactoryWithCloneNode).cloneNode(node)
}

function cloneOptionalNode<Node extends ts.Node>(tsInstance: TypeScript, node: Node | undefined): Node | undefined {
    return node === undefined ? undefined : cloneNode(tsInstance, node)
}

function cloneOptionalNodeArray<Node extends ts.Node>(
    tsInstance: TypeScript,
    nodes: ts.NodeArray<Node> | undefined
): ts.NodeArray<Node> | undefined {
    if (nodes === undefined) {
        return undefined
    }

    return tsInstance.factory.createNodeArray(nodes.map((node) => cloneNode(tsInstance, node)))
}

// ---------------------------------------------------------------------------
// Вспомогательные построители

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

function implementsTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments[] {
    const clause = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })

    return clause === undefined ? [] : [ ...clause.types ]
}

function requiredBaseType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments | undefined {
    return extendsClause(tsInstance, declaration)?.types[0]
}

function requiredBaseIdentifierName(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): string | undefined {
    const requiredBase = requiredBaseType(tsInstance, declaration)

    return requiredBase !== undefined && tsInstance.isIdentifier(requiredBase.expression)
        ? requiredBase.expression.text
        : undefined
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
    if (!hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword) ||
        hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    ) {
        return undefined
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

    return memberNameForDiagnostic(tsInstance, sourceFile, member)
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

type SourceFileWithVersion = ts.SourceFile & {
    version? : string
}

function resolveUsePrintedSourceFile(
    config: MixinClassTransformerConfig,
    compilerOptions: ts.CompilerOptions
): boolean {
    const mode = config.mode

    if (mode === undefined) {
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

function scriptKindFromFileName(tsInstance: TypeScript, fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx") || fileName.endsWith(".mtsx") || fileName.endsWith(".ctsx")) {
        return tsInstance.ScriptKind.TSX
    }

    return tsInstance.ScriptKind.TS
}
