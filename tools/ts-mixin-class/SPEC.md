# Цель проекта

Создать для TypeScript поддержку полноценного множественного наследования классов через явно помеченные mixin-классы.

Класс, помеченный декоратором mixin-класса, должен мочь использоваться другими классами как наследуемый источник поведения и типов.

Класс-потребитель, указывающий несколько таких mixin-классов, должен восприниматься TypeScript-компилятором как обладающий их полями, методами и типовой формой, а в скомпилированном коде должен получать соответствующее runtime-поведение.

Проект должен сохранить обычный TypeScript-синтаксис настолько, насколько это возможно, и превратить описание множественного наследования в корректную для typechecker-а и runtime форму до проверки типов и emit.

# Контекст

Прототип runtime-подхода — пакет [`typescript-mixin-class`](https://www.npmjs.com/package/typescript-mixin-class) (используется в `tools/vidos`): паттерн `Mixin([Base], (base) => class extends base {...})` даёт линеаризацию цепочки прототипов (аналог MRO в Python), дедупликацию ромбовидного наследования и работающие `super`-вызовы сквозь миксины. Его ключевое ограничение — **дженерики**: класс-выражение внутри фабричной функции не может пронести тип-параметры наружу. Это фундаментальное ограничение тайпчекера для value-level композиции (`InstanceType<ReturnType<...>>` не сохраняет дженериковость).

Данный проект снимает это ограничение трансформацией исходника **до** тайпчека: дженерики подставляются синтаксически, а не выводятся чекером. Runtime-модель при этом остаётся той же, отработанной в `typescript-mixin-class`.

# Авторский синтаксис

Автор пишет обычные TypeScript-классы. Mixin-класс помечается декоратором `@mixin()`, импортированным из этого пакета. Потребитель перечисляет миксины в `implements` (с тип-аргументами); обычное одиночное `extends` сохраняется:

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class SourceClass1<T> {
    static staticHelper (x: number): number { return x * 2 }

    value1: string = "value1"

    passThrough1 (a: T): T { return a }

    method1 (): string { return this.value1 }
}

@mixin()
class SourceClass2<A> {
    value2: string = "value2"

    passThrough2 (a: A): A { return a }
}

// миксин может зависеть от другого миксина — тоже через implements
@mixin()
class ChildMixin<T> implements SourceClass1<T> {
    childMethod (a: T): string {
        // super внутри тела миксина указывает на линеаризованного предка
        return "child/" + String(super.passThrough1(a))
    }
}

class Base {
    baseValue: number = 42
}

// потребитель: extends — обычная база, implements — миксины
class Consumer<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer/" + super.method1()   // super достаёт метод миксина
    }
}
```

Семантика: `Consumer<A>` обладает членами `Base`, `SourceClass1<string>` и `SourceClass2<A>` — и по типам, и в runtime (включая инициализаторы полей и статику). Тип-аргументы из `implements` подставляются в типы членов: `consumer.passThrough1` принимает `string`, `consumer.passThrough2` принимает `A`.

# Дизайн трансформации

Все решения ниже подтверждены исполняемыми спайками в `scratch/` (см. раздел «Спайки»).

## Трансформация mixin-класса

`@mixin()`-класс заменяется тремя декларациями: **interface** (типовая форма имени), **фабрика** (runtime-тело, единственный экземпляр) и **const** (само имя как значение):

```ts
// БЫЛО (авторский код):
@mixin()
class SourceClass1<T> {
    static staticHelper (x: number): number { return x * 2 }

    value1: string = "value1"

    passThrough1 (a: T): T { return a }

    method1 (): string { return this.value1 }
}

// СТАЛО (сгенерировано):
interface SourceClass1<T> {                      // 1. сигнатуры инстанс-членов (без тел)
    value1: string
    passThrough1 (a: T): T
    method1 (): string
}

const SourceClass1$mixin = <T>(base: AnyConstructor) => class extends base {   // 2. фабрика
    static staticHelper (x: number): number { return x * 2 }

    value1: string = "value1"

    passThrough1 (a: T): T { return a }

    method1 (): string { return this.value1 }
}

const SourceClass1 = SourceClass1$mixin(Object) as unknown as                  // 3. значение
    (new <T>(...args: any[]) => SourceClass1<T>) &
    ClassStatics<ReturnType<typeof SourceClass1$mixin>>
```

Ключевые решения и их причины:

- **Тело не дублируется** — оно целиком переезжает в фабрику. Дублируются только сигнатуры инстанс-членов в интерфейсе (это неизбежный минимум: извлечь «инстанс-тип для произвольного `T`» из возвращаемого фабрикой класс-выражения чекер не умеет).
- **Дженерик объявляется на стрелке** (`<T>(base) => ...`), а не на класс-выражении. Класс-выражение захватывает тип-параметр объемлющей функции, поэтому типы внутри тела остаются полноценными (никаких `any`). Размещение на стрелке обязательно для зависимых миксинов: тип-параметры класс-выражения запрещено использовать в его extends-выражении (**TS2562** «Base class expressions cannot reference class type parameters»), а тип базы аннотируется именно там.
- **Класс-выражение анонимно.** Если дать ему имя, оно затенит внешний const, и self-reference внутри методов (`new SourceClass1<X>()`) свяжется с *текущим применением* миксина: типово — без дженерика, runtime — с базой текущей цепочки потребителя, что расходится с авторской семантикой standalone-класса. Анонимность направляет self-reference во внешние const (значение, с дженериковой construct signature и статикой) и interface (тип) — семантика авторского кода сохраняется точно. Пустой `constructor.name` анонимного класса восстанавливается runtime-хелпером через `Object.defineProperty(cls, "name", ...)`.
- **Статика не копируется в сгенерированный код.** Статика класса не может ссылаться на его тип-параметры (**TS2302**), то есть всегда не-дженериковая, и извлекается структурно: `ClassStatics<C> = Omit<C, "prototype">` (mapped type отбрасывает construct signature и `prototype`, оставляя статические члены). `ReturnType<typeof SourceClass1$mixin>` инстанцирует дженерик фабрики как `unknown`, статике это безразлично.
- **Каст const-а** (`as unknown as new <T>(...) => SourceClass1<T>`) сознательно стирает выведенный тип выражения `SourceClass1$mixin(Object)` — тот всё равно бесполезен (дженерик инстанцирован `unknown`) — и заменяет его правильным декларативным.

### Зависимые миксины

Зависимость миксина от миксина (`implements` в авторском коде) выражается типом параметра `base` — это даёт типизированный `super` внутри тела:

```ts
// БЫЛО:
@mixin()
class ChildMixin<T> implements SourceClass1<T> {
    childMethod (a: T): string {
        return "child/" + String(super.passThrough1(a))
    }
}

// СТАЛО:
interface ChildMixin<T> extends SourceClass1<T> {
    childMethod (a: T): string
}

const ChildMixin$mixin = <T>(base: AnyConstructor<SourceClass1<T>>) => class extends base {
    childMethod (a: T): string {
        return "child/" + String(super.passThrough1(a))   // super: SourceClass1<T> ✓
    }
}

const ChildMixin = ChildMixin$mixin(SourceClass1$mixin(Object)) as unknown as
    (new <T>(...args: any[]) => ChildMixin<T>) &
    ClassStatics<ReturnType<typeof ChildMixin$mixin>>
```

Зависимости миксина записываются в реестр (см. «Архитектура») — они нужны потребителям для линеаризации цепочки.

## Трансформация потребителя

Типизация потребителя решается **чистым declaration merging** — генерируется промежуточный базовый класс, мержащийся с интерфейсом, и `extends` потребителя переключается на него. Сам класс-потребитель остаётся настоящим классом:

```ts
// БЫЛО:
class Consumer<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer/" + super.method1()
    }
}

// СТАЛО:
interface Consumer$base<A> extends SourceClass1<string>, SourceClass2<A> {}   // дословно из implements
class Consumer$base<A> extends (
    SourceClass2$mixin(SourceClass1$mixin(Base)) as unknown as                // runtime-цепочка
        typeof Base & ClassStatics<typeof SourceClass1> & ClassStatics<typeof SourceClass2>
) {}

class Consumer<A> extends Consumer$base<A> implements SourceClass1<string>, SourceClass2<A> {
    method1 (): string {
        return "consumer/" + super.method1()   // ✓ типизировано и работает в runtime
    }
}
```

Почему так:

- **Тип инстанса класса складывается из двух независимых каналов**: extends-выражение (базовый instance type, конструктор, статика) и declaration merging с одноимённым интерфейсом (добавляет члены к типу инстанса — тот же механизм, что у пар `interface Array<T>` / `var Array` в lib.d.ts). Каст `as unknown as typeof Base & ...` стирает бесполезный выведенный тип цепочки и оставляет первому каналу то, что merging выразить не может: члены, статику и конструктор базы плюс статику миксинов. Члены миксинов приходят целиком из интерфейса.
- **`super` типизируется только из extends-выражения** — merging на самом потребителе его не чинит (проверено: `interface Consumer<A> extends ...` + `class Consumer extends Base` даёт TS2339 на `super.method1()`). Промежуточный класс — минимальное вмешательство, дающее членов миксинов и в `this`, и в `super`.
- Сгенерированный интерфейс **дословно повторяет список `implements`** — трансформер не собирает типы членов, всю работу делает чекер. Тип-аргументы любой сложности (фиксированные, параметры потребителя, выражения над ними) подставляются синтаксически.
- `implements` у потребителя сохраняется — чекер продолжает проверять совместимость переопределений.
- Альтернатива — generic construct signature в касте (`new <A>(...args: any[]) => Base & SourceClass1<string> & SourceClass2<A>`, прецедент `class List<T> extends Array<T>`) — тоже работает (спайки v1/v2), но требует ручной сборки типа; merging-вариант проще и надёжнее. Держим как запасной для возможных edge-cases (например, abstract-члены).

Потребитель без явного `extends` получает цепочку поверх сгенерированного пустого класса. Если хотя бы один применённый миксин требует базу через `extends RequiredBase`, no-base потребитель стартует с этой required-base.

Если потребитель сам является миксином (`@mixin()`-класс с `implements`), применяется трансформация миксина, а зависимость уходит в тип `base` — промежуточный класс не нужен.

## Runtime

Цепочка применений миксинов строится runtime-хелпером (портируется из `typescript-mixin-class`):

- **Линеаризация** зависимостей по алгоритму C3 — каждый миксин применяется в цепочке один раз; ромбовидное наследование дедуплицируется по identity миксина, а конфликтующие требования порядка отклоняются.
- **Мемоизация** линеаризации каждого mixin-класса и применений по паре (миксин, база) — повторное применение к той же базе возвращает закэшированный класс.
- **`Symbol.hasInstance`** на const миксина — `consumer instanceof SourceClass1` работает, хотя сам класс SourceClass1 не лежит в цепочке прототипов потребителя.
- **Имя** анонимного класс-выражения проставляется при применении.
- Инициализаторы полей и `super` работают штатно, потому что тело миксина — настоящее класс-выражение `class extends base`, а статика наследуется через прототипную цепочку конструкторов, которую выставляет `class extends`.

В сгенерированном коде вместо прямой вложенности вызовов (`SourceClass2$mixin(SourceClass1$mixin(Base))`) используется вызов хелпера с эквивалентной семантикой, например `mixinChain(Base, SourceClass1, SourceClass2)` — хелпер сам разворачивает зависимости и дедуплицирует.

## Ограничения на mixin-классы (диагностики трансформера)

- Члены не могут быть `private`/`protected` (ломают interface-extends и пересечения; правило уже зафиксировано в корневом AGENTS.md).
- Явный `constructor` запрещён (v1; инициализаторы полей — можно). Конструирование идёт по цепочке, аргументы конструктора принадлежат базе потребителя.
- `extends` у mixin-класса разрешён и означает required-base: миксин может быть применён только к этой базе или её наследнику. Это диагностируется в typecheck и проверяется в runtime.
- Коллизии статики между базой и миксинами или между несколькими миксинами диагностируются конфигурируемо. По умолчанию включён дешёвый режим `staticCollisionCheck: "never"`; строгая assignability-проверка включается через `"strict"`, а `false` отключает диагностику.
- `implements` не-миксина у `@mixin()`-класса — обычная семантика TypeScript (контракт без наследования поведения).

# Архитектура

Пакет — `ts-patch` **ProgramTransformer** (как `tools/ts-lazy-property`): подменяет `CompilerHost.getSourceFile`, трансформируя файлы до построения программы — то есть до тайпчека и emit.

## Реестр mixin-классов (кросс-файловость)

Потребитель импортирует миксины из других модулей, а трансформация файла потребителя должна знать, какие имена из его `implements` — миксины, и каковы их зависимости. Поэтому `transformProgram` сначала пре-сканирует все файлы исходной `program` (она доступна как аргумент) и строит реестр: `(файл, экспортируемое имя) → { зависимости }`. Импорты потребителя резолвятся через module resolution в записи реестра. Случай «миксин и потребитель в одном файле» работает без резолва.

## Два режима выдачи (как у ts-lazy-property)

1. **Печать + репарс** — для `tsc`-сборки: трансформированный AST печатается принтером и парсится заново. Просто и достаточно для emit; позиции диагностик сдвигаются и требуют маппинга.
2. **Позиционно-сохраняющий AST** — для tsserver/редактора: текст файла **не меняется** (`sourceFile.text` остаётся байт-в-байт равным буферу редактора), трансформируется только AST. Синтетические узлы получают позиции, смапленные на оригинальные токены (`setTextRange` / аналоги `preserveTextRange`, `preserveNodeNameLocation` из ts-lazy-property):
   - member-узлы тела **переиспользуются** в фабрике как те же поддеревья с теми же позициями — Quick Definition, hover, find-references по членам работают без маппинга;
   - имена сгенерированных interface и const мапятся на оригинальный токен имени класса — go-to-definition по типу и по значению приводит на строку авторского `class`;
   - сигнатуры членов интерфейса мапятся на имена соответствующих членов тела;
   - у потребителя меняется только узел цели `extends` (мапится на оригинальную базу), сгенерированные декларации мапятся на имя потребителя и узлы `implements`.

   Эти режимы покрыты тестами на сохранение текста исходника, definition/quickinfo/references/rename и semantic diagnostics.

# Спайки

Дизайн зафиксирован исполняемыми спайками в `scratch/` (тайпчек на TypeScript 6.0.3 + runtime-проверки под Node):

| Файл | Что доказывает |
|---|---|
| `spike-heritage.ts` (v1) | extends значения с generic construct signature: дженерики потребителя, `super`, поля, статика базы — работают |
| `spike-heritage-v2.ts` | тело миксина в фабрике без дублирования; дженерик на стрелке; зависимый миксин с типизированным `super` |
| `spike-heritage-v3.ts` | типизация потребителя чистым declaration merging на промежуточной базе — финальная схема |
| `spike-interface-merge.ts` | границы «голого» merging: инстанс-типы с дженериками — да; `super` — TS2339; runtime — отсутствует |
| `spike-statics.ts` | статика через `ClassStatics<C> = Omit<C, "prototype">` без копирования сигнатур; наследование статики потребителем |
| `spike-self-reference.ts` | анонимное класс-выражение: self-reference резолвится во внешние const/interface; TS2562 для дженерика класса в heritage; runtime-расхождение именованного варианта |

Негативные проверки в спайках оформлены через `@ts-expect-error` — «неизрасходованный» маркер сам становится ошибкой компиляции, поэтому спайки проверяют и то, что чекер реально ловит неверные типы.

# Состояние реализации и тестов

Реализованы и покрыты тестами:

1. **Runtime-хелпер**: C3-линеаризация, дедупликация, мемоизация, required-base runtime checks, `Symbol.hasInstance`.
2. **Трансформация mixin-класса**: interface + factory + runtime const, generic/self-reference/statics, named default export, invalid declaration diagnostics.
3. **Реестр программы**: same-file, imported source, type-only imports, transitive dependencies, declaration-file package boundaries.
4. **Трансформация потребителя**: intermediate base + declaration merging, generic bases, no-base consumers, required-base consumers, static typing.
5. **Фикстуры**: standard/legacy decorator builds, runtime Siesta runs, declaration-package consumers, default-exported mixins, self-reference, statics, `super`, `instanceof`, canonical mixin instantiation.
6. **Диагностики**: invalid mixin declarations, anonymous default mixins, anonymous consumers, unsupported dynamic base expressions, required-base mismatch, C3 linearization conflicts, missing runtime value for declaration-only mixins, configurable static collisions.
7. **Editor-режим**: source-position preservation, tsserver definition/quickinfo/references/rename/semantic diagnostics.

Оставшиеся сознательные ограничения:

- Потребители должны быть именованными top-level class declarations. Вложенные объявления в блоках/functions/namespaces и class expressions требуют отдельной формы трансформации.
- Dynamic consumer base expressions (`extends makeBase()`) пока не поддерживаются и получают diagnostic; будущая поддержка должна сохранить порядок вычисления и типизацию static/instance сторон.
- Коллизии с injected helper imports/generated helper names пока не сканируются явно.
- Конструирование через произвольные constructor signatures не моделируется. Планируемая форма — отдельный статический factory/new protocol.
- `README.md` нужно обновить под текущую реализацию.
