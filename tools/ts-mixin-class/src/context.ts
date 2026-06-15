import path from "node:path"
import type * as ts from "typescript"
import { hasMixinDecorator } from "./decorators.js"
import {
    generatedName,
    implementsTypes,
    instanceConfigProperties,
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
    crossFile?: CrossFileContext
): FileMixinContext {
    const context: FileMixinContext = {
        byLocalName        : new Map(),
        byKey              : new Map(),
        usedFactoryImports : new Map()
    }

    // 1. Mixin classes from this file.
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
                configProperties : instanceConfigProperties(tsInstance, statement, true),
                missingRuntimeImport : undefined
            }

            context.byLocalName.set(name, ref)
            context.byKey.set(ref.key, ref)
        }
    }

    // 2. Imported mixin classes (from the registry).
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

    // 3. Same-file mixin dependencies (by local names from implements).
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

    // 4. Transitive registry closure: dependencies the file does not import.
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

    return context
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
