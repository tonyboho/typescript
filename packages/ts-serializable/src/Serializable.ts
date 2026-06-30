import { Base, mixin } from "ts-mixin-class"
import { ArbitraryObject, AsyncFunction, typeOf } from "./Helpers.js"
import { Mapper, Mutator } from "./Visitor.js"

export type JsonReferenceId = number

type DynamicRecord = Record<PropertyKey, any>
type JsonReference = { $ref: JsonReferenceId }

@mixin()
export class Collapser extends Base implements Mapper {
    public layer? : SerializationLayer = SerializationLayer.new()

    isVisited(value: unknown): boolean {
        return this.layer!.hasObject(value)
    }

    markPreVisited(value: unknown): void {
        this.layer!.registerObject(value)
    }

    markPostVisited(value: unknown, depth: number, visitResult: unknown): unknown {
        const nativeSerializationEntry = nativeSerializableClassesByStringTag.get(typeOf(value))
        const res                      = nativeSerializationEntry
            ? nativeSerializationEntry.toJSON(visitResult as object)
            : visitResult

        return { $refId: this.layer!.refIdOf(value), value: res }
    }

    visitAlreadyVisited(value: unknown, depth: number): JsonReference {
        return { $ref: this.layer!.refIdOf(value) }
    }

    collapse(value: unknown): any {
        return this.visit(value)
    }
}

@mixin()
class ExpanderPhase1 extends Base implements Mapper {
    public layer? : SerializationLayer = SerializationLayer.new()

    markPostVisited(value: unknown, depth: number, visitResult: any): unknown {
        let resolved = visitResult

        if (resolved?.$refId !== undefined) {
            this.layer!.registerObject(resolved.value, resolved.$refId)

            resolved = resolved.value
        }

        return super.markPostVisited(value, depth, resolved)
    }
}

@mixin()
export class Expander extends Base implements Mutator {
    $expander1? : ExpanderPhase1 = undefined

    public mappingVisitSymbol? : symbol = undefined

    public layer? : SerializationLayer = SerializationLayer.new()

    get expander1(): ExpanderPhase1 {
        if (this.$expander1 !== undefined) return this.$expander1

        this.$expander1 = ExpanderPhase1.new({ internalVisitSymbol: this.mappingVisitSymbol })

        return this.$expander1
    }

    markPostVisited(value: unknown, depth: number, visitResult: any): unknown {
        let resolved = visitResult

        if (resolved?.$ref !== undefined) {
            resolved = this.expander1.layer!.objectOf(resolved.$ref)
        }

        return super.markPostVisited(value, depth, resolved)
    }

    expand(value: unknown): any {
        this.expander1.layer = this.layer

        const expanded = this.expander1.visit(value)

        return this.visit(expanded)
    }
}

export class SerializationLayer extends Base {
    refIdSource : JsonReferenceId = 0

    objectToRefId : Map<unknown, JsonReferenceId> = new Map()

    refIdToObject : Map<JsonReferenceId, unknown> = new Map()

    hasObject(object: unknown): boolean {
        return this.objectToRefId.has(object)
    }

    registerObject(object: unknown, id?: JsonReferenceId): void {
        if (id === undefined) id = this.refIdSource++

        this.objectToRefId.set(object, id)
        this.refIdToObject.set(id, object)
    }

    refIdOf(object: unknown): JsonReferenceId {
        const refId = this.objectToRefId.get(object)

        if (refId === undefined) throw new Error("Object has not been registered in the serialization layer.")

        return refId
    }

    objectOf(refId: JsonReferenceId): unknown {
        return this.refIdToObject.get(refId)
    }
}

export class SerializationScope extends Base {
    public currentLayer? : SerializationLayer = SerializationLayer.new()

    stringify(value: unknown, space?: string | number): string {
        const collapser = Collapser.new({ layer: this.currentLayer })
        const decycled  = collapser.collapse(value)

        return JSON.stringify(decycled, null, space)
    }

    parse(text: string): any {
        const decycled = JSON.parse(text, reviver)
        const expander = Expander.new({ layer: this.currentLayer })

        return expander.expand(decycled)
    }
}

export const stringify = (value: any, options?: { collapserVisitSymbol?: symbol, space?: string | number }): string => {
    const decycled = Collapser.new({ internalVisitSymbol: options?.collapserVisitSymbol }).collapse(value)

    return JSON.stringify(decycled, null, options?.space)
}

export const parse = (text: string, options?: { mappingVisitSymbol?: symbol }): any => {
    const decycled = JSON.parse(text, reviver)

    return Expander.new(options).expand(decycled)
}

// Well-known metadata symbol shared between standard (TC39) decorators - where the compiler
// assigns it to `Class[Symbol.metadata]` - and the legacy fallback below. Polyfilled into the
// global `Symbol` so emitted standard-decorator code and this module agree on the same symbol.
const SymbolMetadata: symbol =
    (Symbol as { metadata?: symbol }).metadata ??
    ((Symbol as { metadata?: symbol }).metadata = Symbol.for("Symbol.metadata"))

type SerializableMetadata = {
    $class?    : string
    $mode?     : SerializationMode
    $included? : DynamicRecord
    $excluded? : DynamicRecord
}

type StandardDecoratorContext = { kind: string, name: string | symbol, metadata: SerializableMetadata }

// A standard (TC39) decorator is invoked with a context object carrying `kind`; legacy decorators
// receive a `propertyKey` (string | symbol) or nothing in its place. `symbol` is `typeof "symbol"`,
// never `"object"`, so it never collides with a context.
const isStandardContext = (context: unknown): context is StandardDecoratorContext =>
    typeof context === "object" && context !== null && "kind" in context

// Legacy decorators have no compiler-provided metadata. Synthesize an own metadata object on the
// constructor, inheriting the base class's metadata so excluded/included sets compose like the
// standard prototype-chained metadata does.
const ensureOwnMetadata = (ctor: Function): SerializableMetadata => {
    if (!Object.prototype.hasOwnProperty.call(ctor, SymbolMetadata)) {
        const inherited = (ctor as DynamicRecord)[SymbolMetadata] as SerializableMetadata | undefined

        Object.defineProperty(ctor, SymbolMetadata, {
            value        : Object.create(inherited ?? null),
            configurable : true,
            writable     : true
        })
    }

    return (ctor as DynamicRecord)[SymbolMetadata]
}

const metadataOf = (value: object): SerializableMetadata | undefined =>
    (value.constructor as DynamicRecord)[SymbolMetadata]

@mixin()
export class Serializable {
    toJSON(key: string): unknown {
        const metadata = metadataOf(this)

        if (!metadata?.$class) throw new Error(`Missing serializable class id: ${this.constructor}`)

        const json: DynamicRecord = {}

        if (metadata.$mode === "optOut") {
            for (const [ propertyKey, propValue ] of Object.entries(this)) {
                if (!metadata.$excluded || !metadata.$excluded[propertyKey]) json[propertyKey] = propValue
            }
        }
        else if (metadata.$included) {
            for (const propertyKey in metadata.$included) {
                json[propertyKey] = (this as DynamicRecord)[propertyKey]
            }
        }

        json.$class = metadata.$class

        return json
    }

    static fromJSON(json: object): Serializable {
        const instance: Serializable = Object.create(this.prototype)

        for (const [ key, value ] of Object.entries(json)) {
            if (key !== "$class") (instance as DynamicRecord)[key] = value
        }

        return instance
    }
}

@mixin()
export class SerializableCustom extends Base implements Serializable {
}

const serializableClasses = new Map<string, typeof Serializable>()

const registerSerializableClass = (id: string, cls: typeof Serializable): void => {
    if (serializableClasses.has(id) && serializableClasses.get(id) !== cls) {
        throw new Error(`Serializable class with id: [${id}] already registered`)
    }

    serializableClasses.set(id, cls)
}

export const lookupSerializableClass = (id: string): typeof Serializable | undefined => {
    return serializableClasses.get(id)
}

type JSONObject = Record<string, unknown>
type NativeSerializationEntry<T extends JSONObject, Class extends AnyConstructor> = {
    toJSON   : (native: InstanceType<Class>) => T,
    fromJSON : (json: T) => InstanceType<Class>
}

const nativeSerializableClassesByStringTag = new Map<string, NativeSerializationEntry<JSONObject, AnyConstructor>>()
const nativeSerializableClassesById        = new Map<string, NativeSerializationEntry<JSONObject, AnyConstructor>>()

const registerNativeSerializableClass = <T extends JSONObject, Class extends AnyConstructor>(cls: Class, entry: NativeSerializationEntry<T, Class>): void => {
    nativeSerializableClassesByStringTag.set(cls.name, entry as NativeSerializationEntry<JSONObject, AnyConstructor>)
    nativeSerializableClassesById.set(cls.name, entry as NativeSerializationEntry<JSONObject, AnyConstructor>)
}

export type SerializationMode = "optIn" | "optOut"

// Works as both a standard (TC39) and a legacy (experimental) class decorator. In both modes the
// first argument is the constructor; the standard mode additionally passes a context whose
// `metadata` the compiler exposes as `Class[Symbol.metadata]`, while legacy mode gets its metadata
// synthesized on the constructor.
export const serializable = (opts?: { id?: string, mode?: SerializationMode }) => {
    // `any` target/return so the same factory is accepted in both decorator positions (standard and
    // legacy) and stays identity-preserving on the decorated class type. Membership is enforced at
    // runtime, which lets the guard reject classes that omit the `Serializable` mixin.
    return (target: any, context?: unknown): any => {
        const cls = target as typeof Serializable

        if (!(cls.prototype instanceof Serializable)) {
            throw new Error(`The class [${cls.name}] is decorated with @serializable, but does not include the Serializable mixin.`)
        }

        const id       = opts?.id ?? cls.name
        const metadata = isStandardContext(context) ? context.metadata : ensureOwnMetadata(cls)

        metadata.$class = id
        metadata.$mode  = opts?.mode ?? "optOut"

        registerSerializableClass(id, cls)

        return target
    }
}

// Shared body for `@exclude`/`@include`. Standard mode receives a field context and writes into
// `context.metadata`; legacy mode receives `(prototype, propertyKey)` and writes into the
// constructor's synthesized metadata. Each bucket is prototype-chained off the inherited one so a
// subclass extends, rather than replaces, its base's set.
const markProperty = (bucket: "$excluded" | "$included") => {
    return (target: unknown, context?: unknown): void => {
        let metadata : SerializableMetadata
        let key      : PropertyKey

        if (isStandardContext(context)) {
            metadata = context.metadata
            key      = context.name
        }
        else {
            metadata = ensureOwnMetadata((target as object).constructor)
            key      = context as PropertyKey
        }

        if (!Object.prototype.hasOwnProperty.call(metadata, bucket)) {
            metadata[bucket] = Object.create(metadata[bucket] ?? null)
        }

        metadata[bucket]![key] = true
    }
}

export const exclude = () => markProperty("$excluded")

export const include = () => markProperty("$included")

export const reviver = function(key: string | number, value: number | string | boolean | ArbitraryObject): unknown {
    if (typeof value === "object" && value !== null) {
        const $class = value.$class as string | undefined

        if ($class !== undefined) {
            const cls = lookupSerializableClass($class)

            if (!cls) throw new Error(`Unknown serializable class id: ${$class}`)

            return cls.fromJSON(value)
        }

        const $$class = value.$$class as string | undefined

        if ($$class !== undefined) {
            const entry = nativeSerializableClassesById.get($$class)

            if (!entry) throw new Error(`Unknown native serializable class id: ${$$class}`)

            return entry.fromJSON(value)
        }
    }

    return value
}

registerNativeSerializableClass(Function, {
    toJSON : (func: Function) => {
        return {
            $$class : "Function",
            source  : `(${func.toString()})`
        }
    },
    fromJSON : data => {
        return globalThis.eval(data.source)
    }
})

registerNativeSerializableClass(AsyncFunction, {
    toJSON : (func: Function) => {
        return {
            $$class : "AsyncFunction",
            source  : `(${func.toString()})`
        }
    },
    fromJSON : data => {
        return globalThis.eval(data.source)
    }
})

registerNativeSerializableClass(Map, {
    toJSON : (map: Map<unknown, unknown>) => {
        return {
            $$class : "Map",
            entries : Array.from(map.entries())
        }
    },
    fromJSON : data => {
        return new Map(data.entries)
    }
})

registerNativeSerializableClass(Set, {
    toJSON : (set: Set<unknown>) => {
        return {
            $$class : "Set",
            entries : Array.from(set)
        }
    },
    fromJSON : data => {
        return new Set(data.entries)
    }
})

registerNativeSerializableClass(Date, {
    toJSON : (date: Date) => {
        return {
            $$class : "Date",
            time    : date.getTime()
        }
    },
    fromJSON : data => {
        return new Date(data.time)
    }
})

const errorClasses = [ Error, TypeError, RangeError, EvalError, ReferenceError, SyntaxError, URIError ]

errorClasses.forEach(cls =>
    registerNativeSerializableClass(cls, {
        toJSON : (error: Error) => {
            return Object.assign({}, error as unknown as JSONObject, {
                $$class : cls.name,
                stack   : error.stack,
                message : error.message,
                name    : error.name
            })
        },
        fromJSON : data => {
            const error = Object.create(cls.prototype) as Error & DynamicRecord

            Object.assign(error, data)

            delete error.$$class

            error.stack   = data.stack
            error.message = data.message
            error.name    = data.name

            return error
        }
    })
)
