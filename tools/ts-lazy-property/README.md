# ts-lazy-property

TypeScript transformer that expands `@lazy()` class properties.

## Intro

The value of some properties could be rather costly to initialize and rarely needed, or not needed at all. In such cases, its quite beneficial to transform such property into a lazy property, with delayed initialization, which happens only during the first access to it. This involves certain amount of boilerplate, which this package aims to remove.

For example:

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = 'init_expression'
}
```

Will be internally expanded to:

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

The evaluation of the `init_expression` is delayed, and performed only during the first access to the property.

## Example

A more practical example:

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty() : string {
        return 'init_expression'
    }
}
```

Which is expanded to:

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

    buildLazyProperty() : string {
        return 'lazy_initializer'
    }
}
```

When you need to refresh the value of the lazy property and re-evaluate its initializing expression, simply assign `undefined` to its `$` equivalent. The next access to the property will trigger an initializer. If you need to check, whether the property has value or not without triggering an initializer, access the `$lazyProperty` directly.

```ts
import { lazy } from "ts-lazy-property"

class SourceClass {
    @lazy()
    lazyProperty: string = this.buildLazyProperty()

    buildLazyProperty() : string {
        return 'lazy_initializer'
    }

    refreshLazyProperty() {
        this.$lazyProperty = undefined

        // will trigger a `this.buildLazyProperty()` expression
        this.lazyProperty
    }

    processing() {
        if (this.$lazyProperty !== undefined) {
            // property has value
        } else {
            // property does not have value
        }
    }
}
```


## Setup

Include `ts-patch` as the development dependency:

```
"devDependencies": {
    "ts-patch": "4.0.1",
}
```

Include as a compiler plugin in the `tsconfig.json`:

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

Add a `prepare` script to your `package.json`

```json
{
    "scripts": {
        "prepare": "ts-patch install"
    }
}
```

Run `prepare` once so `ts-patch` patches your local TypeScript:

```shell
npm run prepare
```

## Details

The expansion happens at the pre-compile timing, inside the TS code, it does not involve the emitter. This allows to actually create a new property, which starts with a dollar sign: `$lazyProperty` and access to this property will typecheck.

The extra getter and setter are created in the "virtual" intermediate sources and on the same line as the original property. This keeps line numbers consistent with the original file.

## License

MIT License
