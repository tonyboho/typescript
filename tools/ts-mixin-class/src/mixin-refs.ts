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
                    reachableMixinKeys(context, other.ref.key).has(ref.key)
            })
        })
        .map((entry) => entry.heritageType)
}

// All registry keys reachable through `startKey`'s transitive dependencies.
// Memoized per key on the (program-wide when cross-file) reachability cache, so
// reduceTransitiveMixinHeritageTypes resolves each pair with an O(1) set lookup
// instead of re-walking the dependency graph for every consumer and file.
function reachableMixinKeys(context: FileMixinContext, startKey: string): Set<string> {
    return collectReachableMixinKeys(context, startKey, new Set())
}

function collectReachableMixinKeys(
    context: FileMixinContext,
    startKey: string,
    visiting: Set<string>
): Set<string> {
    const cached = context.reachabilityCache.get(startKey)

    if (cached !== undefined) {
        return cached
    }

    // A back-edge means a dependency cycle (rejected elsewhere by C3). Return an
    // empty, uncached set for the revisited node to break the recursion, matching
    // the previous `seen`-guard behavior.
    if (visiting.has(startKey)) {
        return new Set()
    }

    visiting.add(startKey)

    const reachable = new Set<string>()
    const ref = context.byKey.get(startKey)

    if (ref !== undefined) {
        for (const dependencyKey of ref.dependencies) {
            reachable.add(dependencyKey)

            for (const transitiveKey of collectReachableMixinKeys(context, dependencyKey, visiting)) {
                reachable.add(transitiveKey)
            }
        }
    }

    visiting.delete(startKey)
    context.reachabilityCache.set(startKey, reachable)

    return reachable
}
