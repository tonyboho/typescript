export class C3LinearizationError<T> extends Error {
    constructor(readonly pendingSequences: readonly T[][]) {
        super("Cannot linearize sequences with the C3 algorithm")
    }
}

type PendingSequence<T> = {
    sequence : T[],
    offset   : number
}

type Candidate<T> =
    | { found: true, value: T }
    | { found: false }

export function mergeC3Linearizations<T>(sequences: readonly (readonly T[])[]): T[] {
    const result: T[] = []
    const pending = sequences
        .map((sequence) => [ ...new Set(sequence) ])
        .filter((sequence) => sequence.length > 0)
        .map((sequence): PendingSequence<T> => {
            return {
                sequence,
                offset : 0
            }
        })

    while (pending.length > 0) {
        const candidate = findC3Candidate(pending)

        if (!candidate.found) {
            throw new C3LinearizationError(remainingSequences(pending))
        }

        result.push(candidate.value)
        consumeC3Candidate(pending, candidate.value)
    }

    return result
}

function findC3Candidate<T>(pending: readonly PendingSequence<T>[]): Candidate<T> {
    const tails = new Set<T>()

    for (const pendingSequence of pending) {
        for (let index = pendingSequence.offset + 1; index < pendingSequence.sequence.length; index++) {
            tails.add(pendingSequence.sequence[index])
        }
    }

    for (const pendingSequence of pending) {
        const head = pendingSequence.sequence[pendingSequence.offset]

        if (!tails.has(head)) {
            return {
                found : true,
                value : head
            }
        }
    }

    return { found : false }
}

function consumeC3Candidate<T>(pending: PendingSequence<T>[], candidate: T): void {
    const candidateSet = new Set([ candidate ])

    for (let index = pending.length - 1; index >= 0; index--) {
        const pendingSequence = pending[index]

        if (candidateSet.has(pendingSequence.sequence[pendingSequence.offset])) {
            pendingSequence.offset++
        }

        if (pendingSequence.offset === pendingSequence.sequence.length) {
            pending.splice(index, 1)
        }
    }
}

function remainingSequences<T>(pending: readonly PendingSequence<T>[]): T[][] {
    return pending.map((pendingSequence) => {
        return pendingSequence.sequence.slice(pendingSequence.offset)
    })
}
