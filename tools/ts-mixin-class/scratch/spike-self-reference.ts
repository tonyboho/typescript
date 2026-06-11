// Spike: self-reference на имя mixin-класса внутри его собственных методов.
//
// Проблема: при `<T>(base) => class SourceClass1 extends base {...}` внутри
// методов имя SourceClass1 — это класс-выражение БЕЗ дженерика, и
// `new SourceClass1<X>()` не типизируется (наблюдение пользователя).
//
// Два решения:
//   (a) дженерик на класс-выражении, имя остаётся:
//           (base) => class SourceClass1<T> extends base {...}
//       типизация чинится, НО имя затеняет внешний const — `new SourceClass1()`
//       создаёт экземпляр ТЕКУЩЕГО применения (поверх базы цепочки потребителя),
//       что расходится с авторским смыслом standalone-класса.
//   (b) АНОНИМНОЕ класс-выражение, дженерик остаётся на стрелке:
//           <T>(base: AnyConstructor) => class extends base {...}
//       затенения нет — self-reference резолвится во внешний const (+interface),
//       у которого есть и дженерики, и статика; runtime детерминирован
//       (новый экземпляр всегда поверх Object, как в авторском классе).
//
// Примечание: вариант "дженерик на классе + типизированная база в heritage-касте"
// (class <T> extends (base as AnyConstructor<Dep<T>>)) НЕВОЗМОЖЕН — TS2562
// "Base class expressions cannot reference class type parameters". Поэтому для
// зависимых миксинов тип базы выражается только через дженерик стрелки.
//
// Спайк проверяет (b) как основной вариант и демонстрирует runtime-различие с (a).

type AnyConstructor<T extends object = object> = new (...args: any[]) => T
type ClassStatics<C> = Omit<C, "prototype">

// ---------------------------------------------------------------------------
// Вариант (b): анонимное generic класс-выражение

interface SourceClass1<T> {
    value1: string
    passThrough1 (a: T): T
    method1 (): string
    makeAnother (): SourceClass1<number>
}

const SourceClass1$mixin = <T>(base: AnyConstructor) => class extends base {
    value1: string = "value1"

    passThrough1 (a: T): T {
        return a
    }

    method1 (): string {
        return this.value1
    }

    makeAnother (): SourceClass1<number> {
        // self-reference: и тип, и значение берутся из внешних деклараций,
        // дженерик доступен
        return new SourceClass1<number>()
    }
}

const SourceClass1 = SourceClass1$mixin(Object) as unknown as
    (new <T>(...args: any[]) => SourceClass1<T>) & ClassStatics<ReturnType<typeof SourceClass1$mixin>>

// зависимый миксин: T в скоупе и у членов, и в heritage-касте —
// типизированный super без дженерика на стрелке

interface ChildMixin<T> extends SourceClass1<T> {
    childMethod (a: T): string
}

const ChildMixin$mixin = <T>(base: AnyConstructor<SourceClass1<T>>) => class extends base {
    childMethod (a: T): string {
        return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
    }
}

const ChildMixin = ChildMixin$mixin(SourceClass1$mixin(Object)) as unknown as
    (new <T>(...args: any[]) => ChildMixin<T>) & ClassStatics<ReturnType<typeof ChildMixin$mixin>>

// ---------------------------------------------------------------------------
// Вариант (a) для контраста: именованное generic класс-выражение

const Named$mixin = (base: AnyConstructor) => class Named<T> extends base {
    valueN: string = "n"

    passThroughN (a: T): T {
        return a
    }

    makeAnotherNamed (): { valueN: string } {
        // типизируется (дженерик на классе есть), НО имя Named — это
        // класс-выражение текущего применения: экземпляр получит
        // прототипную цепочку ТЕКУЩЕЙ базы
        return new Named<number>()
    }
}

// ---------------------------------------------------------------------------
// База и потребители

class Base {
    baseValue: number = 42
}

interface Consumer$base<A> extends ChildMixin<A> {}
class Consumer$base<A> extends (ChildMixin$mixin(SourceClass1$mixin(Base)) as unknown as typeof Base) {}

class Consumer<A> extends Consumer$base<A> implements ChildMixin<A> {
}

interface NamedConsumer$base {
    valueN: string
    passThroughN (a: string): string
    makeAnotherNamed (): { valueN: string }
}
class NamedConsumer$base extends (Named$mixin(Base) as unknown as typeof Base) {}

class NamedConsumer extends NamedConsumer$base {
}

// ---------------------------------------------------------------------------
// Статические проверки типов

const c = new Consumer<boolean>()

const t1: string  = c.childMethod(true)
const t2: boolean = c.passThrough1(false)

// self-instantiation с дженериком типизирована
const another = c.makeAnother()
const t3: number = another.passThrough1(5)

// @ts-expect-error makeAnother возвращает SourceClass1<number>
const e1: string = another.passThrough1(5)

// @ts-expect-error childMethod принимает A = boolean
const e2: string = c.childMethod("x")

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

assertEqual(c.childMethod(true), "child/true/value1", "super calls in dependent mixin body work")
assertEqual(c.baseValue, 42, "Consumer gets base field")

// (b): self-instantiation детерминирована — поверх Object, как в авторском классе
const fresh = c.makeAnother()
assertEqual(fresh.value1, "value1", "Self-created instance has mixin fields")
assertEqual("baseValue" in fresh, false, "(b) anonymous: self-created instance does NOT drag consumer's base")
assertEqual(fresh instanceof SourceClass1, true, "(b) self-created instance instanceof outer const")

// (a): именованное класс-выражение тянет базу текущей цепочки
const namedConsumer = new NamedConsumer()
const freshNamed = namedConsumer.makeAnotherNamed()
assertEqual(freshNamed.valueN, "n", "(a) named: self-created instance has mixin fields")
assertEqual("baseValue" in freshNamed, true, "(a) named: self-created instance DOES drag consumer's base (divergence!)")

console.log("spike-self-reference: done")

void [t1, t2, t3, e1, e2, another, ChildMixin]
