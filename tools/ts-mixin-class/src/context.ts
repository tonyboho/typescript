import path from "node:path"
import type * as ts from "typescript"
import {
    generatedName,
    mixinFactorySuffix,
    mixinValueSuffix,
    normalizePath,
    registryKey,
    type CrossFileContext,
    type FileMixinContext,
    type ImportedNameBinding,
    type MixinDecoratorImports,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

export function buildImportedNameMap(
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

export function buildFileMixinContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions,
    crossFile?: CrossFileContext,
    facts = getSourceFileFacts(tsInstance, sourceFile, options)
): FileMixinContext {
    const context: FileMixinContext = {
        byLocalName        : new Map(),
        byKey              : new Map(),
        usedFactoryImports : new Map()
    }

    addLocalMixinRefs(sourceFile, imports, facts, context)

    if (crossFile !== undefined) {
        addImportedMixinRefs(tsInstance, sourceFile, crossFile, context)
    }

    addSameFileDependencies(facts, context)

    if (crossFile !== undefined) {
        addTransitiveRegistryClosure(sourceFile, crossFile, context)
    }

    return context
}

function addLocalMixinRefs(
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    if (imports.identifiers.size > 0 || imports.namespaces.size > 0) {
        for (const classFacts of facts.classes) {
            if (!classFacts.hasMixinDecorator || classFacts.name === undefined) {
                continue
            }

            const name = classFacts.name
            const ref: ResolvedMixinRef = {
                key              : registryKey(sourceFile.fileName, name),
                className        : name,
                localValueName   : name,
                localFactoryName : generatedName(name, mixinFactorySuffix),
                factoryImport    : undefined,
                requiredBase     : undefined,
                dependencies     : [],
                declaration      : classFacts.declaration,
                configProperties : classFacts.configProperties,
                missingRuntimeImport : undefined
            }

            context.byLocalName.set(name, ref)
            context.byKey.set(ref.key, ref)
        }
    }
}

function addImportedMixinRefs(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    crossFile: CrossFileContext,
    context: FileMixinContext
): void {
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
                configProperties : registered.configProperties,
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

function addSameFileDependencies(
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    for (const ref of context.byLocalName.values()) {
        if (ref.declaration === undefined) {
            continue
        }

        const classFacts = facts.classesByDeclaration.get(ref.declaration)

        if (classFacts === undefined) {
            continue
        }

        for (const dependencyName of classFacts.implementsIdentifierNames) {
            const dependency = context.byLocalName.get(dependencyName)

            if (dependency !== undefined) {
                ref.dependencies.push(dependency.key)
            }
        }
    }
}

function addTransitiveRegistryClosure(
    sourceFile: ts.SourceFile,
    crossFile: CrossFileContext,
    context: FileMixinContext
): void {
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
            configProperties : registered.configProperties,
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

export function relativeImportSpecifier(fromFileName: string, toFileName: string): string {
    const relative = path.posix.relative(
        path.posix.dirname(normalizePath(fromFileName)),
        normalizePath(toFileName)
    )

    const withoutExtension = relative
        .replace(/\.[cm]?tsx?$/, "")

    return withoutExtension.startsWith(".") ? withoutExtension : "./" + withoutExtension
}
