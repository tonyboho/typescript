import { Base, mixin } from "ts-mixin-class"
import { isAtomicValue, typeOf, uppercaseFirst } from "./Helpers.js"

export const visitorVisitSymbol = Symbol("internalVisitSymbol")

export const PreVisit = Symbol("PreVisit")

type DynamicRecord = Record<PropertyKey, any>

@mixin()
export class Visitor extends Base {
    maxDepth : number = Number.MAX_SAFE_INTEGER

    visited : Map<unknown, unknown> = new Map()

    public internalVisitSymbol? : symbol = visitorVisitSymbol

    isVisited(value: unknown): boolean {
        return this.visited.has(value)
    }

    markPreVisited(value: unknown): void {
        this.visited.set(value, PreVisit)
    }

    markPostVisited(value: unknown, depth: number, visitResult: unknown): unknown {
        this.visited.set(value, visitResult)

        return visitResult
    }

    visit(value: unknown, depth: number = 0): unknown {
        if (depth >= this.maxDepth) {
            return this.visitOutOfDepthValue(value, depth + 1)
        }
        else if (isAtomicValue(value)) {
            return this.visitAtomicValueEntry(value, depth + 1)
        }
        else if (this.isVisited(value)) {
            return this.visitAlreadyVisited(value, depth + 1)
        }

        return this.visitNotVisited(value as object, depth + 1)
    }

    visitOutOfDepthValue(value: unknown, depth: number): unknown {
        return value
    }

    visitAtomicValue(value: unknown, depth: number): unknown {
        return value
    }

    visitAtomicValueEntry(value: unknown, depth: number): unknown {
        const specificVisitorMethod = `visit${uppercaseFirst(typeOf(value))}`

        const visitMethod = (this as DynamicRecord)[specificVisitorMethod] ?? this.visitAtomicValue

        return visitMethod.call(this, value, depth)
    }

    visitAlreadyVisited(value: unknown, depth: number): unknown {
        return value
    }

    visitNotVisited(value: object, depth: number): unknown {
        this.markPreVisited(value)

        const customVisit = (value as DynamicRecord)[this.internalVisitSymbol!] as
            ((visitor: this, depth: number) => unknown) | undefined

        if (customVisit !== undefined) {
            const visitResult = customVisit(this, depth)

            return this.markPostVisited(value, depth, visitResult)
        }

        const specificVisitorMethod = `visit${uppercaseFirst(typeOf(value))}`

        const visitMethod = (this as DynamicRecord)[specificVisitorMethod] ?? this.visitObject
        const visitResult = visitMethod.call(this, value, depth)

        return this.markPostVisited(value, depth, visitResult)
    }

    visitObject(object: object, depth: number): unknown {
        const entries = Object.entries(object) as [ PropertyKey, unknown ][]

        entries.forEach(([ key, value ], index) => {
            this.visitObjectEntryKey(key, value, object, index, entries, depth)
            this.visitObjectEntryValue(key, value, object, index, entries, depth)
        })

        return object
    }

    visitObjectEntryKey(
        key: PropertyKey,
        value: unknown,
        object: object,
        index: number,
        entries: [ PropertyKey, unknown ][],
        depth: number
    ): unknown {
        return this.visitAtomicValueEntry(key, depth)
    }

    visitObjectEntryValue(
        key: PropertyKey,
        value: unknown,
        object: object,
        index: number,
        entries: [ PropertyKey, unknown ][],
        depth: number
    ): unknown {
        return this.visit(value, depth)
    }

    visitArray(array: unknown[], depth: number): unknown {
        array.forEach((value, index) => this.visitArrayEntry(value, array, index, depth))

        return array
    }

    visitArrayEntry<V>(value: V, array: V[], index: number, depth: number): unknown {
        return this.visit(value, depth)
    }

    visitSet(set: Set<unknown>, depth: number): unknown {
        let index = 0

        for (const value of set) this.visitSetElement(value, set, index++, depth)

        return set
    }

    visitSetElement<V>(value: V, set: Set<V>, index: number, depth: number): unknown {
        return this.visit(value, depth)
    }

    visitMap(map: Map<unknown, unknown>, depth: number): unknown {
        let index = 0

        for (const [ key, value ] of map) {
            this.visitMapEntryKey(key, value, map, index, depth)
            this.visitMapEntryValue(key, value, map, index++, depth)
        }

        return map
    }

    visitMapEntryKey<K, V>(key: K, value: V, map: Map<K, V>, index: number, depth: number): unknown {
        return this.visit(key, depth)
    }

    visitMapEntryValue<K, V>(key: K, value: V, map: Map<K, V>, index: number, depth: number): unknown {
        return this.visit(value, depth)
    }

    visitDate(date: Date, depth: number): unknown {
        return date
    }

    visitFunction(func: Function, depth: number): unknown {
        return func
    }

    visitAsyncFunction(func: Function, depth: number): unknown {
        return func
    }

    visitError(error: Error, depth: number): unknown {
        return error
    }

    visitTypeError(error: TypeError, depth: number): unknown {
        return error
    }

    visitRangeError(error: RangeError, depth: number): unknown {
        return error
    }

    visitEvalError(error: EvalError, depth: number): unknown {
        return error
    }

    visitReferenceError(error: ReferenceError, depth: number): unknown {
        return error
    }

    visitSyntaxError(error: SyntaxError, depth: number): unknown {
        return error
    }

    visitURIError(error: URIError, depth: number): unknown {
        return error
    }
}

@mixin()
export class Mapper extends Base implements Visitor {
    visitObject(object: object, depth: number): unknown {
        const entries   = Object.entries(object) as [ PropertyKey, unknown ][]
        const newObject = Object.create(Object.getPrototypeOf(object)) as DynamicRecord

        entries.forEach(([ key, value ], index) => {
            const visitedKey = this.visitObjectEntryKey(key, value, object, index, entries, depth) as PropertyKey

            newObject[visitedKey] = this.visitObjectEntryValue(key, value, object, index, entries, depth)
        })

        return newObject
    }

    visitArray(array: unknown[], depth: number): unknown {
        return array.map((value, index) => this.visitArrayEntry(value, array, index, depth))
    }

    visitSet(set: Set<unknown>, depth: number): unknown {
        let index = 0

        const newSet = new Set()

        for (const value of set) {
            newSet.add(this.visitSetElement(value, set, index++, depth))
        }

        return newSet
    }

    visitMap(map: Map<unknown, unknown>, depth: number): unknown {
        let index = 0

        const newMap = new Map()

        for (const [ key, value ] of map) {
            newMap.set(
                this.visitMapEntryKey(key, value, map, index, depth),
                this.visitMapEntryValue(key, value, map, index++, depth)
            )
        }

        return newMap
    }

    visitDate(date: Date, depth: number): unknown {
        return new Date(date)
    }
}

@mixin()
export class Mutator extends Base implements Visitor {
    visitObject(object: object, depth: number): unknown {
        const entries = Object.entries(object) as [ PropertyKey, unknown ][]
        const mutable = object as DynamicRecord

        entries.forEach(([ key, value ], index) => {
            const visitedKey   = this.visitObjectEntryKey(key, value, object, index, entries, depth) as PropertyKey
            const visitedValue = this.visitObjectEntryValue(key, value, object, index, entries, depth)

            if (visitedKey !== key) {
                delete mutable[key]
                mutable[visitedKey] = visitedValue
            }
            else if (visitedValue !== value) {
                mutable[visitedKey] = visitedValue
            }
        })

        return object
    }

    visitArray(array: unknown[], depth: number): unknown {
        array.forEach((value, index) => array[index] = this.visitArrayEntry(value, array, index, depth))

        return array
    }

    visitSet(set: Set<unknown>, depth: number): unknown {
        let index = 0

        // Prefetch the collection before mutating it.
        const elements = Array.from(set)

        elements.forEach(value => {
            const visited = this.visitSetElement(value, set, index++, depth)

            if (visited !== value) {
                set.delete(value)
                set.add(visited)
            }
        })

        return set
    }

    visitMap(map: Map<unknown, unknown>, depth: number): unknown {
        let index = 0

        // Prefetch the collection before mutating it.
        const entries = Array.from(map.entries())

        entries.forEach(([ key, value ]) => {
            const visitedKey   = this.visitMapEntryKey(key, value, map, index, depth)
            const visitedValue = this.visitMapEntryValue(visitedKey, value, map, index++, depth)

            if (visitedKey !== key) {
                map.delete(key)
                map.set(visitedKey, visitedValue)
            }
            else if (visitedValue !== value) {
                map.set(visitedKey, visitedValue)
            }
        })

        return map
    }
}
