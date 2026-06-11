// Spike: статика mixin-классов.
//
// Ключевые факты:
//   1. Статика класса не может ссылаться на его тип-параметры (TS2302),
//      значит статическая часть миксина всегда не-дженериковая.
//   2. Поэтому её НЕ нужно копировать в сгенерированный код — она извлекается
//      структурно: ClassStatics<C> = Omit<C, 'prototype'> (mapped type
//      отбрасывает construct signature, остаются только статические члены).
//   3. В runtime статика наследуется сама: class extends выставляет прототип
//      конструктора, цепочка конструкторов даёт и статику Base, и статику
//      каждого применённого миксина.

type AnyConstructor<T extends object = object> = new (...args: any[]) => T

// извлечение статической части класса (войдёт в runtime-вход пакета)
type ClassStatics<C> = Omit<C, "prototype">

// ---------------------------------------------------------------------------
// Сгенерировано из:
//
//     @mixin()
//     class SourceClass1<T> {
//         static staticValue: number = 10
//         static staticHelper (x: number): number { return x * 2 }
//         ...
//     }

interface SourceClass1<T> {
    value1: string
    passThrough1 (a: T): T
}

const SourceClass1$mixin = <T>(base: AnyConstructor) => class SourceClass1 extends base {
    static staticValue: number = 10

    static staticHelper (x: number): number {
        return x * 2
    }

    value1: string = "value1"

    passThrough1 (a: T): T {
        return a
    }
}

// статика попадает в тип const-а структурно, из типа самой фабрики —
// трансформер НЕ знает, какие там члены
const SourceClass1 = SourceClass1$mixin(Object) as unknown as
    (new <T>(...args: any[]) => SourceClass1<T>) & ClassStatics<ReturnType<typeof SourceClass1$mixin>>

// второй миксин без статики — для проверки, что пересечение не мешает

interface SourceClass2<A> {
    value2: string
    passThrough2 (a: A): A
}

const SourceClass2$mixin = <A>(base: AnyConstructor) => class SourceClass2 extends base {
    value2: string = "value2"

    passThrough2 (a: A): A {
        return a
    }
}

const SourceClass2 = SourceClass2$mixin(Object) as unknown as
    (new <A>(...args: any[]) => SourceClass2<A>) & ClassStatics<ReturnType<typeof SourceClass2$mixin>>

// ---------------------------------------------------------------------------
// Обычная база со статикой

class Base {
    baseValue: number = 42

    static staticBase (): string {
        return "staticBase"
    }
}

// ---------------------------------------------------------------------------
// Потребитель: в касте промежуточной базы статика миксинов добавляется
// пересечением ClassStatics<typeof ...> — опять чисто по именам

interface Consumer$base<A> extends SourceClass1<string>, SourceClass2<A> {}
class Consumer$base<A> extends (
    SourceClass2$mixin(SourceClass1$mixin(Base)) as unknown as
        typeof Base & ClassStatics<typeof SourceClass1> & ClassStatics<typeof SourceClass2>
) {}

export class Consumer<A> extends Consumer$base<A> implements SourceClass1<string>, SourceClass2<A> {
}

// ---------------------------------------------------------------------------
// Статические проверки типов

// статика на самом mixin-классе при прямом использовании
const t1: number = SourceClass1.staticHelper(2)
const t2: number = SourceClass1.staticValue

// @ts-expect-error staticHelper принимает number
const e1: number = SourceClass1.staticHelper("x")

// статика миксина унаследована потребителем
const t3: number = Consumer.staticHelper(3)
const t4: number = Consumer.staticValue

// статика базы не потерялась
const t5: string = Consumer.staticBase()

// @ts-expect-error несуществующая статика отвергается
const e2: unknown = Consumer.noSuchStatic

// инстансная часть по-прежнему работает
const c = new Consumer<boolean>()
const t6: string  = c.passThrough1("x")
const t7: boolean = c.passThrough2(true)

// ---------------------------------------------------------------------------
// Runtime-проверки

function assertEqual (actual: unknown, expected: unknown, message: string): void {
    if (actual !== expected) {
        console.error(`FAIL: ${message}: expected ${String(expected)}, got ${String(actual)}`)
        process.exitCode = 1
    } else {
        console.log(`ok: ${message}`)
    }
}

assertEqual(SourceClass1.staticHelper(2), 4, "Mixin static method works directly")
assertEqual(SourceClass1.staticValue, 10, "Mixin static field works directly")

assertEqual(Consumer.staticHelper(3), 6, "Consumer inherits mixin static method")
assertEqual(Consumer.staticValue, 10, "Consumer inherits mixin static field")
assertEqual(Consumer.staticBase(), "staticBase", "Consumer keeps base statics")

assertEqual(c.value1, "value1", "Instance part still works")

console.log("spike-statics: done")

void [t1, t2, t3, t4, t5, t6, t7, e1, e2]
