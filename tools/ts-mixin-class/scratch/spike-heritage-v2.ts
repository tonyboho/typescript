// Spike v2: heritage rewrite БЕЗ дублирования тел.
//
// Автор пишет:
//
//     @mixin()
//     class SourceClass1<T> {
//         value1: string = "value1"
//         passThrough1 (a: T): T { return a }
//         method1 (): string { return this.value1 }
//     }
//
// Трансформер заменяет это на три декларации ниже:
//   1. interface с сигнатурами членов (типовая форма имени, дженерики живут тут)
//   2. фабрика — тело класса в ЕДИНСТВЕННОМ экземпляре, дженерик на стрелке,
//      внутри тела типы полноценные (никаких any)
//   3. const с тем же именем — сам класс как значение, тип задаётся кастом
//
// Это ровно паттерн typescript-mixin-class, но сгенерированный из обычного класса.

type AnyConstructor<T extends object = object> = new (...args: any[]) => T

// ---------------------------------------------------------------------------
// Сгенерировано из @mixin() class SourceClass1<T>

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

const SourceClass1 = SourceClass1$mixin(Object) as unknown as
    new <T>(...args: any[]) => SourceClass1<T>

// ---------------------------------------------------------------------------
// Сгенерировано из @mixin() class SourceClass2<A>

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

const SourceClass2 = SourceClass2$mixin(Object) as unknown as
    new <A>(...args: any[]) => SourceClass2<A>

// ---------------------------------------------------------------------------
// Миксин, зависящий от другого миксина:
// @mixin() class ChildMixin<T> implements SourceClass1<T> { ... }
// База фабрики типизируется требуемым миксином — super работает внутри тела.

interface ChildMixin<T> extends SourceClass1<T> {
    childMethod (): string
}

const ChildMixin$mixin = <T>(base: AnyConstructor<SourceClass1<T>>) => class ChildMixin extends base {
    childMethod (): string {
        return "child/" + super.method1()
    }
}

// ---------------------------------------------------------------------------
// Обычный базовый класс — не трансформируется

class Base {
    baseValue: number = 42

    baseMethod (): string {
        return "base"
    }

    static staticBase (): string {
        return "staticBase"
    }
}

// ---------------------------------------------------------------------------
// Потребители (как в спайке v1, чтобы убедиться что типовая поверхность та же)

const Consumer1$mixed = SourceClass2$mixin(SourceClass1$mixin(Object)) as unknown as
    new <T, A>(...args: any[]) => SourceClass1<T> & SourceClass2<A>

class Consumer1<T, A> extends Consumer1$mixed<T, A> implements SourceClass1<T>, SourceClass2<A> {
}

const Consumer2$mixed = SourceClass2$mixin(SourceClass1$mixin(Base)) as unknown as
    (new <A>(...args: any[]) => Base & SourceClass1<string> & SourceClass2<A>) & typeof Base

class Consumer2<A> extends Consumer2$mixed<A> implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer2/" + super.method1()
    }
}

// Потребитель миксина-с-зависимостью: цепочка линеаризуется
const Consumer3$mixed = ChildMixin$mixin(SourceClass1$mixin(Base)) as unknown as
    (new <T>(...args: any[]) => Base & ChildMixin<T>) & typeof Base

class Consumer3<T> extends Consumer3$mixed<T> implements ChildMixin<T> {
}

// ---------------------------------------------------------------------------
// Статические проверки типов

const c1 = new Consumer1<string, number>()

const t1: string = c1.passThrough1("x")
const t2: number = c1.passThrough2(1)

// @ts-expect-error T = string, number не подходит
const e1: string = c1.passThrough1(1)

const c2 = new Consumer2<boolean>()

const t3: string  = c2.passThrough1("fixed")
const t4: boolean = c2.passThrough2(true)
const t5: string  = Consumer2.staticBase()

const c3 = new Consumer3<number>()

const t6: string = c3.childMethod()
const t7: number = c3.passThrough1(5)

// прямое использование mixin-класса как обычного
const direct = new SourceClass1<number>()
const t8: number = direct.passThrough1(3)

// @ts-expect-error дженерик у прямого инстанса тоже проверяется
const e2: string = direct.passThrough1(3)

// присваиваемость
const asMixin: SourceClass1<string> = c2
const asChild: ChildMixin<number> = c3

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
assertEqual(c2.baseValue, 42, "Consumer2 gets base field")
assertEqual(Consumer2.staticBase(), "staticBase", "Consumer2 inherits base statics")

assertEqual(c3.childMethod(), "child/value1", "ChildMixin super call inside mixin body works")
assertEqual(c3.value1, "value1", "Consumer3 gets transitive mixin field")

assertEqual(direct.value1, "value1", "Direct mixin instantiation works")
assertEqual(direct.method1(), "value1", "Direct mixin method works")

console.log("spike-heritage-v2: done")

void [t1, t2, t3, t4, t5, t6, t7, t8, e1, e2, asMixin, asChild]
