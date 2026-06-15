import type * as ts from "typescript"
import {
    implementsTypes,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
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

export function localMixinRefs(
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ResolvedMixinRef[] {
    return heritageTypes.map((heritageType) => {
        return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
    })
}
