export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

export type ClassStatics<C> = Omit<C, "prototype">

export type NonFunctionPropertyNames<T> = {
    [Key in keyof T]: T[Key] extends (...args: any[]) => any ? never : Key
}[keyof T]

export type Config<T> = Partial<Pick<T, NonFunctionPropertyNames<T>>>

export type StaticNeverConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] & ClassStatics<Right>[Key] ] extends [ never ]
            ? Key
            : never
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type StaticStrictConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] ] extends [ ClassStatics<Right>[Key] ]
            ? [ ClassStatics<Right>[Key] ] extends [ ClassStatics<Left>[Key] ]
                ? never
                : Key
            : Key
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type MixinFactory = (base: AnyConstructor<any>) => AnyConstructor<any>

export class Base {
    initialize(props?: Config<this>): void {
        if (props !== undefined) {
            Object.assign(this, props)
        }
    }

    static new<T extends typeof Base>(this: T, props?: Config<InstanceType<T>>): InstanceType<T> {
        const instance = new this() as InstanceType<T>

        instance.initialize(props)

        return instance
    }

}

export const factory: unique symbol = Symbol.for("ts-mixin-class.factory") as any
export const requirements: unique symbol = Symbol.for("ts-mixin-class.requirements") as any
export const base: unique symbol = Symbol.for("ts-mixin-class.base") as any

export type RuntimeMixinClass<RequiredBase extends object = object> = {
    readonly [factory]: MixinFactory,
    readonly [requirements]: readonly RuntimeMixinClass[],
    readonly [base]: AnyConstructor<RequiredBase>
}

type RuntimeMixinClassValue = AnyConstructor<any> & RuntimeMixinClass

type RuntimeMixinMetadata = {
    factory: MixinFactory,
    requirements: RuntimeMixinClassValue[],
    requiredBase: AnyConstructor<any>,
    linearization: RuntimeMixinClassValue[] | undefined,
    applications: WeakMap<AnyConstructor<any>, AnyConstructor<any>>
}

const runtimeMixinMetadata = new WeakMap<RuntimeMixinClassValue, RuntimeMixinMetadata>()
const appliedMixinClasses = new WeakMap<AnyConstructor<any>, Set<RuntimeMixinClassValue>>()

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

export function defineMixinClass(
    name: string,
    mixinFactory: MixinFactory,
    mixinRequirements: readonly RuntimeMixinClassValue[] = [],
    requiredBase: AnyConstructor<any> = Object
): RuntimeMixinClassValue {
    const requirementList = [ ...mixinRequirements ]
    const requirementLinearization = linearizeRuntimeRequirements(requirementList)
    const canonicalBase = applyRuntimeMixins(requiredBase, requirementLinearization.slice().reverse())
    const mixinClass = mixinFactory(canonicalBase) as RuntimeMixinClassValue
    const applications = new WeakMap<AnyConstructor<any>, AnyConstructor<any>>()

    applications.set(canonicalBase, mixinClass)

    runtimeMixinMetadata.set(mixinClass, {
        factory        : mixinFactory,
        requirements   : requirementList,
        requiredBase,
        linearization  : [ mixinClass, ...requirementLinearization ],
        applications
    })

    Object.defineProperty(mixinClass, factory, { value : mixinFactory })
    Object.defineProperty(mixinClass, requirements, { value : requirementList })
    Object.defineProperty(mixinClass, base, { value : requiredBase })
    Object.defineProperty(mixinClass, Symbol.hasInstance, {
        value(instance: unknown) {
            return hasRuntimeMixinInstance(instance, mixinClass)
        }
    })

    setClassName(mixinClass, name)
    registerAppliedMixins(mixinClass, [ mixinClass, ...requirementLinearization ])

    return mixinClass
}

export function mixinChain<Base extends AnyConstructor<any>>(
    base: Base,
    ...mixins: RuntimeMixinClassValue[]
): AnyConstructor<any> {
    return applyRuntimeMixins(base, linearizeRuntimeRequirements(mixins).slice().reverse())
}

function applyRuntimeMixins(
    base: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): AnyConstructor<any> {
    let current = base

    for (const mixinClass of mixins) {
        current = applyRuntimeMixin(current, mixinClass)
    }

    return current
}

function applyRuntimeMixin(
    base: AnyConstructor<any>,
    mixinClass: RuntimeMixinClassValue
): AnyConstructor<any> {
    const metadata = runtimeMetadataOf(mixinClass)
    const cached = metadata.applications.get(base)

    if (!classExtends(base, metadata.requiredBase)) {
        throw new Error(
            `Mixin class ${mixinClass.name || "<anonymous>"} requires base ` +
            `${metadata.requiredBase.name || "<anonymous>"}`
        )
    }

    if (cached !== undefined) {
        return cached
    }

    const appliedClass = metadata.factory(base)

    metadata.applications.set(base, appliedClass)
    setClassName(appliedClass, mixinClass.name)
    registerAppliedMixins(appliedClass, [ mixinClass, ...linearizeRuntimeMixin(mixinClass).slice(1) ])

    return appliedClass
}

function linearizeRuntimeMixin(mixinClass: RuntimeMixinClassValue): RuntimeMixinClassValue[] {
    const metadata = runtimeMetadataOf(mixinClass)

    if (metadata.linearization !== undefined) {
        return metadata.linearization
    }

    metadata.linearization = [
        mixinClass,
        ...linearizeRuntimeRequirements(metadata.requirements)
    ]

    return metadata.linearization
}

function linearizeRuntimeRequirements(
    mixins: readonly RuntimeMixinClassValue[]
): RuntimeMixinClassValue[] {
    if (mixins.length === 0) {
        return []
    }

    return mergeRuntimeLinearizations([
        ...mixins.map((mixinClass) => [ ...linearizeRuntimeMixin(mixinClass) ]),
        [ ...mixins ]
    ])
}

function mergeRuntimeLinearizations(sequences: RuntimeMixinClassValue[][]): RuntimeMixinClassValue[] {
    const result: RuntimeMixinClassValue[] = []
    const pending = sequences
        .map((sequence) => sequence.filter((mixinClass, index) => sequence.indexOf(mixinClass) === index))
        .filter((sequence) => sequence.length > 0)

    while (pending.length > 0) {
        const candidate = pending
            .map((sequence) => sequence[0])
            .find((head) => {
                return pending.every((sequence) => !sequence.slice(1).includes(head))
            })

        if (candidate === undefined) {
            throw new Error("Cannot linearize mixin classes: inconsistent requirements")
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

function runtimeMetadataOf(mixinClass: RuntimeMixinClassValue): RuntimeMixinMetadata {
    const metadata = runtimeMixinMetadata.get(mixinClass)

    if (metadata === undefined) {
        throw new Error(`Class ${mixinClass.name || "<anonymous>"} is not a registered mixin class`)
    }

    return metadata
}

function classExtends(base: AnyConstructor<any>, requiredBase: AnyConstructor<any>): boolean {
    return requiredBase === Object ||
        base === requiredBase ||
        requiredBase.prototype.isPrototypeOf(base.prototype)
}

function registerAppliedMixins(
    appliedClass: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): void {
    const inherited = appliedMixinClasses.get(Object.getPrototypeOf(appliedClass)) ?? new Set<RuntimeMixinClassValue>()
    const applied = new Set<RuntimeMixinClassValue>(inherited)

    for (const mixinClass of mixins) {
        applied.add(mixinClass)
    }

    appliedMixinClasses.set(appliedClass, applied)
}

function hasRuntimeMixinInstance(instance: unknown, mixinClass: RuntimeMixinClassValue): boolean {
    if (instance === null || typeof instance !== "object" && typeof instance !== "function") {
        return false
    }

    let constructor = (instance as { constructor?: unknown }).constructor

    while (typeof constructor === "function") {
        if (appliedMixinClasses.get(constructor as AnyConstructor<any>)?.has(mixinClass)) {
            return true
        }

        constructor = Object.getPrototypeOf(constructor)
    }

    return false
}

function setClassName(classConstructor: AnyConstructor<any>, name: string): void {
    if (name.length === 0) {
        return
    }

    Object.defineProperty(classConstructor, "name", {
        configurable : true,
        value        : name
    })
}
