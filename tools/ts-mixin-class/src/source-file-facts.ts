import type * as ts from "typescript"
import { collectMixinDecoratorImports, hasMixinDecorator } from "./decorators.js"
import {
    extendsClause,
    implementsTypes,
    instanceConfigProperties,
    propertyNameText,
    requiredBaseIdentifierName,
    type ConfigProperty,
    type MixinDecoratorImports,
    type TransformOptions
} from "./model.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

export type ImportFacts = {
    declaration : ts.ImportDeclaration,
    specifier   : string,
    localNames  : string[]
}

export type ClassFacts = {
    declaration               : ts.ClassDeclaration,
    name                      : string | undefined,
    defaultExport             : boolean,
    extendsType               : ts.ExpressionWithTypeArguments | undefined,
    implementsTypes           : ts.ExpressionWithTypeArguments[],
    implementsIdentifierNames : string[],
    requiredBaseName          : string | undefined,
    configProperties          : ConfigProperty[],
    staticNames               : Set<string>,
    hasStaticNew              : boolean,
    hasMixinDecorator         : boolean
}

export type SourceFileFacts = {
    mixinDecoratorImports : MixinDecoratorImports,
    imports              : ImportFacts[],
    classes              : ClassFacts[],
    classesByName        : Map<string, ClassFacts>,
    classesByDeclaration : Map<ts.ClassDeclaration, ClassFacts>
}

const sourceFileFactsCache = new WeakMap<ts.SourceFile, Map<string, SourceFileFacts>>()

export function getSourceFileFacts(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): SourceFileFacts {
    const cacheKey = sourceFileFactsCacheKey(options)
    const cached = sourceFileFactsCache.get(sourceFile)?.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const facts = collectSourceFileFacts(tsInstance, sourceFile, options)
    const cachedByOptions = sourceFileFactsCache.get(sourceFile) ?? new Map<string, SourceFileFacts>()

    cachedByOptions.set(cacheKey, facts)
    sourceFileFactsCache.set(sourceFile, cachedByOptions)

    return facts
}

function collectSourceFileFacts(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): SourceFileFacts {
    const mixinDecoratorImports = collectMixinDecoratorImports(tsInstance, sourceFile, options)
    const imports: ImportFacts[] = []
    const classes: ClassFacts[] = []
    const classesByName = new Map<string, ClassFacts>()
    const classesByDeclaration = new Map<ts.ClassDeclaration, ClassFacts>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isImportDeclaration(statement) && tsInstance.isStringLiteral(statement.moduleSpecifier)) {
            imports.push(importFacts(tsInstance, statement))
            continue
        }

        if (!tsInstance.isClassDeclaration(statement)) {
            continue
        }

        const facts = classFacts(tsInstance, statement, mixinDecoratorImports, options)

        classes.push(facts)
        classesByDeclaration.set(statement, facts)

        if (facts.name !== undefined) {
            classesByName.set(facts.name, facts)
        }
    }

    return {
        mixinDecoratorImports,
        imports,
        classes,
        classesByName,
        classesByDeclaration
    }
}

function importFacts(
    tsInstance: TypeScript,
    declaration: ts.ImportDeclaration
): ImportFacts {
    const importClause = declaration.importClause
    const namedBindings = importClause?.namedBindings
    const localNames = [
        ...(importClause?.name === undefined ? [] : [ importClause.name.text ]),
        ...(namedBindings !== undefined && tsInstance.isNamedImports(namedBindings)
            ? namedBindings.elements.map((element) => element.name.text)
            : [])
    ]

    return {
        declaration,
        specifier : (declaration.moduleSpecifier as ts.StringLiteral).text,
        localNames
    }
}

function classFacts(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinDecoratorImports: MixinDecoratorImports,
    options: TransformOptions
): ClassFacts {
    const implementedTypes = implementsTypes(tsInstance, declaration)
    const staticNames = staticMemberNames(tsInstance, declaration)

    return {
        declaration,
        name                      : declaration.name?.text,
        defaultExport             : hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword),
        extendsType               : extendsClause(tsInstance, declaration)?.types[0],
        implementsTypes           : implementedTypes,
        implementsIdentifierNames : implementedTypes
            .map((heritageType) => heritageType.expression)
            .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
            .map((expression) => expression.text),
        requiredBaseName          : requiredBaseIdentifierName(tsInstance, declaration),
        configProperties          : instanceConfigProperties(tsInstance, declaration, true),
        staticNames,
        hasStaticNew              : staticNames.has("new"),
        hasMixinDecorator         : hasMixinDecorator(tsInstance, declaration, mixinDecoratorImports, options)
    }
}

function staticMemberNames(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): Set<string> {
    const names = new Set<string>()

    for (const member of declaration.members) {
        if (!hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) || member.name === undefined) {
            continue
        }

        const name = propertyNameText(tsInstance, member.name)

        if (name !== undefined) {
            names.add(name)
        }
    }

    return names
}

function sourceFileFactsCacheKey(options: TransformOptions): string {
    return [
        options.packageName,
        options.decoratorName
    ].join("|")
}
