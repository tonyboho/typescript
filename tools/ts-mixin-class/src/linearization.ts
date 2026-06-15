import {
    DependencyLinearizationError,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"

export function linearizeDependencies(
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
