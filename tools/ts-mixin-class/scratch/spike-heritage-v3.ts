// Spike v3: типизация потребителя ЦЕЛИКОМ через declaration merging
// (идея "interface merge", но на промежуточном базовом классе — чинит super).
//
// Для потребителя трансформер генерирует две декларации:
//
//     interface Consumer2$base<A> extends SourceClass1<string>, SourceClass2<A> {}
//     class Consumer2$base<A> extends (runtimeChain as typeof Base) {}
//
// и меняет extends потребителя на Consumer2$base<A>. Никаких кастов
// construct-signature, никакого копирования сигнатур членов для потребителя.
//
// Mixin-классы здесь в форме v2 (тело в фабрике + интерфейс), но это
// ортогонально — типовая поверхность миксина это interface + дженерики.

type AnyConstructor<T extends object = object> = new (...args: any[]) => T

// ---------------------------------------------------------------------------
// Миксины (форма v2)

interface SourceClass1<T> {
    value1: string
    passThrough1 (a: T): T
    method1 (): string
}

const SourceClass1$mixin = <T>(base: AnyConstructor) => class SourceClass1 extends base {
    value1: string = "value1"

    passThrough1 (a: T): T {
        return a
    }

    method1 (): string {
        return this.value1
    }
}

interface SourceClass2<A> {
    value2: string
    passThrough2 (a: A): A
    method2 (): string
}

const SourceClass2$mixin = <A>(base: AnyConstructor) => class SourceClass2 extends base {
    value2: string = "value2"

    passThrough2 (a: A): A {
        return a
    }

    method2 (): string {
        return this.value2
    }
}

// миксин, зависящий от миксина (с super-вызовом внутри тела)

interface ChildMixin<T> extends SourceClass1<T> {
    childMethod (): string
}

const ChildMixin$mixin = <T>(base: AnyConstructor<SourceClass1<T>>) => class ChildMixin extends base {
    childMethod (): string {
        return "child/" + super.method1()
    }
}

// ---------------------------------------------------------------------------
// Обычная база

export class Base {
    baseValue: number = 42

    baseMethod (): string {
        return "base"
    }

    static staticBase (): string {
        return "staticBase"
    }
}

// ---------------------------------------------------------------------------
// Consumer1: без явной базы

interface Consumer1$base<T, A> extends SourceClass1<T>, SourceClass2<A> {}
class Consumer1$base<T, A> extends (SourceClass2$mixin(SourceClass1$mixin(Object)) as AnyConstructor) {}



export class Consumer1<T, A> extends Consumer1$base<T, A> implements SourceClass1<T>, SourceClass2<A> {
}

// ---------------------------------------------------------------------------
// Consumer2: явная база + фиксированный тип-аргумент + super-вызов

interface Consumer2$base<A> extends SourceClass1<string>, SourceClass2<A> {}
class Consumer2$base<A> extends (SourceClass2$mixin(SourceClass1$mixin(Base)) as unknown as typeof Base) {}

export class Consumer2<A> extends Consumer2$base<A> implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer2/" + super.method1()
    }
}

// ---------------------------------------------------------------------------
// Consumer3: миксин с зависимостью

interface Consumer3$base<T> extends ChildMixin<T> {}
class Consumer3$base<T> extends (ChildMixin$mixin(SourceClass1$mixin(Base)) as unknown as typeof Base) {}

class Consumer3<T> extends Consumer3$base<T> implements ChildMixin<T> {
}

// ---------------------------------------------------------------------------
// Статические проверки типов

const c1 = new Consumer1<string, number>()

const t1: string = c1.passThrough1("x")
const t2: number = c1.passThrough2(1)
const t3: string = c1.value1

// @ts-expect-error T = string, number не подходит
const e1: string = c1.passThrough1(1)

const c2 = new Consumer2<boolean>()

const t4: string  = c2.passThrough1("fixed")
const t5: boolean = c2.passThrough2(true)
const t6: number  = c2.baseValue
const t7: string  = Consumer2.staticBase()

// @ts-expect-error первый миксин зафиксирован как SourceClass1<string>
const e2: string = c2.passThrough1(1)

const c3 = new Consumer3<number>()

const t8: string = c3.childMethod()
const t9: number = c3.passThrough1(5)

// присваиваемость
const asMixin1: SourceClass1<string> = c2
const asMixin2: SourceClass2<number> = c1
const asBase: Base = c2

// дальнейшее наследование с проносом дженерика
class SubConsumer<A> extends Consumer2<A> {
    method2 (): string {
        return "sub/" + super.method2()
    }
}

const sub = new SubConsumer<number>()
const t10: number = sub.passThrough2(7)

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

assertEqual(c1.value1, "value1", "Consumer1 gets field from mixin 1")
assertEqual(c1.value2, "value2", "Consumer1 gets field from mixin 2")
assertEqual(c1.method1(), "value1", "Consumer1 mixin method works")

assertEqual(c2.method1(), "consumer2/value1", "Consumer2 super.method1() reaches mixin")
assertEqual(c2.method2(), "value2", "Consumer2 mixin 2 method works")
assertEqual(c2.baseValue, 42, "Consumer2 gets base field")
assertEqual(Consumer2.staticBase(), "staticBase", "Consumer2 inherits base statics")

assertEqual(c3.childMethod(), "child/value1", "ChildMixin super call inside mixin body works")
assertEqual(c3.value1, "value1", "Consumer3 gets transitive mixin field")

assertEqual(sub.method2(), "sub/value2", "SubConsumer super chain works")
assertEqual(sub instanceof Consumer2, true, "instanceof consumer works")
assertEqual(sub instanceof Base, true, "instanceof base works")

console.log("spike-heritage-v3: done")

void [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, e1, e2, asMixin1, asMixin2, asBase]
