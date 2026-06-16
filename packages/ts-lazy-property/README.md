# ts-lazy-property

TypeScript transformer that expands `@lazy()` class properties.

## Intro

Some properties can be costly to initialize and are rarely needed, or not needed at all. In such cases, it is useful to turn the property into a lazy property, with initialization delayed until the first access. This involves a certain amount of boilerplate, which this package aims to remove.

For example:

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = 'init_expression'
}
```

It will be internally expanded to:

```ts
class SourceClass {
    $lazyProperty: string | undefined = undefined

    get lazyProperty(): string {
        if (this.$lazyProperty !== undefined) return this.$lazyProperty

        return this.$lazyProperty = 'init_expression'
    }

    set lazyProperty(value: string) {
        this.$lazyProperty = value
    }
}
```

The evaluation of `init_expression` is delayed and performed only on the first access to the property.

## Usage

A more practical example:

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty(): string {
        return 'init_expression'
    }
}
```

It is expanded to:

```ts
class SourceClass {
    $lazyProperty: string | undefined = undefined

    get lazyProperty(): string {
        if (this.$lazyProperty !== undefined) return this.$lazyProperty

        return this.$lazyProperty = this.buildLazyProperty()
    }

    set lazyProperty(value: string) {
        this.$lazyProperty = value
    }

    buildLazyProperty(): string {
        return 'init_expression'
    }
}
```

### Re-initialize

To refresh the value of the lazy property and re-evaluate its initializer, assign `undefined` to the backing `$lazyProperty` member. The next access to the property will run the initializer again. If you need to check whether the property already has a value without triggering the initializer, access `$lazyProperty` directly.

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty(): string {
        return 'lazy_initializer'
    }

    refreshLazyProperty() {
        this.$lazyProperty = undefined

        // Will trigger `this.buildLazyProperty()`.
        this.lazyProperty
    }

    processing() {
        if (this.$lazyProperty !== undefined) {
            // The property has a value.
        } else {
            // The property does not have a value.
        }
    }
}
```

### Readonly

If a lazy property has a `readonly` modifier, only a getter is generated for it, so assigning to it is not possible. Re-initialization, however, still works the same way.

## Setup

Include `ts-lazy-property` as a regular dependency and `ts-patch` as a dev
dependency:

```json
{
    "dependencies": {
        "ts-lazy-property": "0.0.1"
    },
    "devDependencies": {
        "ts-patch": "4.0.1"
    }
}
```

Include `ts-lazy-property` as a compiler plugin in `tsconfig.json`:

```json
{
    "compilerOptions": {
        "plugins": [
            {
                "transform": "ts-lazy-property",
                "transformProgram": true
            }
        ]
    }
}
```

Add a `prepare` script to your `package.json`:

```json
{
    "scripts": {
        "prepare": "ts-patch install"
    }
}
```

Run `prepare` once so `ts-patch` patches your local TypeScript:

```shell
pnpm run prepare
```

## Details

The expansion happens before type checking, not in the emitter. This allows the transformer to create the backing `$lazyProperty` member early enough for direct access to type-check.

The exported `lazy()` decorator is a runtime no-op. It is used only as a marker for the transformer, and both standard decorators and legacy `experimentalDecorators` are supported.

The generated backing property, getter, and setter are created in the virtual intermediate source on the same line as the original property. This keeps line numbers consistent with the original file.

## Options

The additional `backingPrefix` option is supported. It controls the prefix of the generated backing property and defaults to `"$"`.

```json
{
    "compilerOptions": {
        "plugins": [
            {
                "transform": "ts-lazy-property",
                "transformProgram": true,
                "backingPrefix": "$"
            }
        ]
    }
}
```


## License

MIT License
