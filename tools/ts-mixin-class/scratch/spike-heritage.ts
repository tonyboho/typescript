// Spike: вариант "heritage rewrite".
// Этот файл — руками написанный ожидаемый ВЫХОД трансформера.
// Проверяем: дженерики, super-вызовы, поля, статика базы, ромб не проверяем (отдельно).

// ---------------------------------------------------------------------------
// Runtime-хелпер (войдёт в runtime-вход пакета)

type AnyConstructor<T extends object = object> = new (...args: any[]) => T

// ---------------------------------------------------------------------------
// Mixin-классы: оригиналы остаются как есть (источник типов)

class SourceClass1<T> {
    value1: string = "value1"

    passThrough1 (a: T): T {
        return a
    }

    method1 (): string {
        return this.value1
    }
}

class SourceClass2<A> {
    value2: string = "value2"

    passThrough2 (a: A): A {
        return a
    }

    method2 (): string {
        return this.value2
    }
}

// ---------------------------------------------------------------------------
// Сгенерированные фабрики: runtime-копии тел, типы ослаблены до any

const SourceClass1$mixin = (base: AnyConstructor) => class SourceClass1 extends base {
    value1: string = "value1"

    passThrough1 (a: any): any {
        return a
    }

    method1 (): string {
        return this.value1
    }
}

const SourceClass2$mixin = (base: AnyConstructor) => class SourceClass2 extends base {
    value2: string = "value2"

    passThrough2 (a: any): any {
        return a
    }

    method2 (): string {
        return this.value2
    }
}

// ---------------------------------------------------------------------------
// Обычный базовый класс

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
// Consumer1: без явной базы, два дженерик-параметра пробрасываются в миксины

const Consumer1$mixed = SourceClass2$mixin(SourceClass1$mixin(Object)) as unknown as
    new <T, A>(...args: any[]) => SourceClass1<T> & SourceClass2<A>

class Consumer1<T, A> extends Consumer1$mixed<T, A> implements SourceClass1<T>, SourceClass2<A> {
}

// ---------------------------------------------------------------------------
// Consumer2: явная база + фиксированный тип-аргумент у первого миксина,
// переопределение метода с super-вызовом, статика базы через `& typeof Base`

const Consumer2$mixed = SourceClass2$mixin(SourceClass1$mixin(Base)) as unknown as
    (new <A>(...args: any[]) => Base & SourceClass1<string> & SourceClass2<A>) & typeof Base

class Consumer2<A> extends Consumer2$mixed<A> implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer2/" + super.method1()
    }
}

// ---------------------------------------------------------------------------
// Статические проверки типов

const c1 = new Consumer1<string, number>()

const t1: string = c1.passThrough1("x")
const t2: number = c1.passThrough2(1)
const t3: string = c1.value1
const t4: string = c1.method2()

// @ts-expect-error дженерик T = string, number не подходит
const e1: string = c1.passThrough1(1)

// @ts-expect-error результат passThrough2 — number, не string
const e2: string = c1.passThrough2(1)

const c2 = new Consumer2<boolean>()

const t5: string  = c2.passThrough1("fixed-to-string")
const t6: boolean = c2.passThrough2(true)
const t7: string  = c2.baseMethod()
const t8: number  = c2.baseValue
const t9: string  = Consumer2.staticBase()

// @ts-expect-error первый миксин зафиксирован как SourceClass1<string>
const e3: string = c2.passThrough1(1)

// Присваиваемость: потребитель совместим с типом миксина
const asMixin1: SourceClass1<string> = c2
const asMixin2: SourceClass2<number> = new Consumer1<string, number>()
const asBase: Base = c2

// Дальнейшее наследование от потребителя с проносом дженерика
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
assertEqual(c1.method1(), "value1", "Consumer1 gets method from mixin 1")
assertEqual(c1.passThrough2(5), 5, "Consumer1 passThrough works")

assertEqual(c2.baseValue, 42, "Consumer2 gets base field")
assertEqual(c2.method1(), "consumer2/value1", "Consumer2 super.method1() reaches mixin")
assertEqual(c2.method2(), "value2", "Consumer2 gets mixin 2 method")
assertEqual(Consumer2.staticBase(), "staticBase", "Consumer2 inherits base statics")

assertEqual(sub.method2(), "sub/value2", "SubConsumer super chain works")
assertEqual(sub instanceof Consumer2, true, "instanceof consumer works")
assertEqual(sub instanceof Base, true, "instanceof base works")

console.log("spike-heritage: done")

// заглушки на неиспользуемые переменные статических проверок
void [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, e1, e2, e3, asMixin1, asMixin2, asBase]
