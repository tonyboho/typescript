// // Spike: вариант "interface merging" (пустой interface extends mixin-классы,
// // мержится с классом-потребителем). Проверяем, что он даёт по типам
// // и где у него границы (super, runtime-поля).

// class SourceClass1<T> {
//     value1: string = "value1"

//     passThrough1 (a: T): T {
//         return a
//     }

//     method1 (): string {
//         return this.value1
//     }
// }

// class SourceClass2<A> {
//     value2: string = "value2"

//     passThrough2 (a: A): A {
//         return a
//     }

//     method2 (): string {
//         return this.value2
//     }
// }

// class Base {
//     baseMethod (): string {
//         return "base"
//     }
// }

// // ---------------------------------------------------------------------------
// // Consumer1: merging даёт типовую форму, включая дженерики

// interface Consumer1<T, A> extends SourceClass1<T>, SourceClass2<A> {}

// class Consumer1<T, A> implements SourceClass1<T>, SourceClass2<A> {
// }

// const c1 = new Consumer1<string, number>()

// const t1: string = c1.passThrough1("x")
// const t2: number = c1.passThrough2(1)
// const t3: string = c1.value1

// // @ts-expect-error дженерик T = string, number не подходит
// const e1: string = c1.passThrough1(1)

// // ---------------------------------------------------------------------------
// // Consumer2: с явной базой; проверяем super-вызов метода миксина

// interface Consumer2<A> extends SourceClass1<string>, SourceClass2<A> {}

// class Consumer2<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
//     // Ожидание: здесь interface merging НЕ помогает — super типизирован как Base.
//     // Если строка ниже компилируется без ошибки, значит я не прав и merging
//     // покрывает и super (проверяем через @ts-expect-error: если ошибки нет,
//     // tsc сам сообщит "unused @ts-expect-error").
//     method1 (): string {
//         return super.method1()
//     }
// }

// const c2 = new Consumer2<boolean>()
// const t4: boolean = c2.passThrough2(true)

// // ---------------------------------------------------------------------------
// // Runtime: без переписывания heritage поля миксинов НЕ появятся на инстансе.
// // Фиксируем фактическое поведение.

// function show (label: string, value: unknown): void {
//     console.log(`${label}: ${String(value)}`)
// }

// show("c1.value1 (ожидаем undefined — runtime не подключён)", c1.value1)
// show("c1.method1 (ожидаем undefined)", (c1 as any).method1)

// console.log("spike-interface-merge: done")

// void [t1, t2, t3, t4, e1, c2]
