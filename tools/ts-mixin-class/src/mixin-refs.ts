import type * as ts from "typescript"
import {
    implementsTypes,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
import type { ClassFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

export function localMixinHeritageTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            context.byLocalName.has(heritageType.expression.text)
    })
}

export function localMixinHeritageTypesFromFacts(
    tsInstance: TypeScript,
    classFacts: ClassFacts,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return classFacts.implementsTypes.filter((heritageType) => {
        return tsInstance.isIdentifier(heritageType.expression) &&
            context.byLocalName.has(heritageType.expression.text)
    })
}

export function localMixinRefs(
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ResolvedMixinRef[] {
    return heritageTypes.map((heritageType) => {
        return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
    })
}

// Work around https://github.com/microsoft/TypeScript/issues/63555 by keeping
// the generated type heritage graph smaller. This intentionally removes only
// simple local, non-generic mixin heritage entries that are already reachable
// through another direct mixin. Runtime dependency metadata stays unchanged.
// Ideally this helper can be removed once TypeScript handles this shape
// efficiently upstream.
export function reduceTransitiveMixinHeritageTypes(
    tsInstance: TypeScript,
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ts.ExpressionWithTypeArguments[] {
    const direct = heritageTypes.map((heritageType) => {
        if (!tsInstance.isIdentifier(heritageType.expression) || heritageType.typeArguments !== undefined) {
            return { heritageType, ref : undefined }
        }

        return {
            heritageType,
            ref : context.byLocalName.get(heritageType.expression.text)
        }
    })

    return direct
        .filter((entry) => {
            const ref = entry.ref

            if (ref === undefined) {
                return true
            }

            return !direct.some((other) => {
                return other !== entry &&
                    other.ref !== undefined &&
                    other.heritageType.typeArguments === undefined &&
                    dependsOnMixin(context, other.ref.key, ref.key)
            })
        })
        .map((entry) => entry.heritageType)
}

function dependsOnMixin(
    context: FileMixinContext,
    startKey: string,
    targetKey: string,
    seen = new Set<string>()
): boolean {
    if (seen.has(startKey)) {
        return false
    }

    seen.add(startKey)

    const ref = context.byKey.get(startKey)

    if (ref === undefined) {
        return false
    }

    return ref.dependencies.some((dependencyKey) => {
        return dependencyKey === targetKey || dependsOnMixin(context, dependencyKey, targetKey, seen)
    })
}
