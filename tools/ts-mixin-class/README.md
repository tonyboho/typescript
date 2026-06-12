# ts-mixin-class

TypeScript program transformer for class-level mixins.

Mark reusable class bodies with `@mixin()` and list them from a consumer class in
`implements`:

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class SourceMixin {
    value: string = "value"

    method (): string {
        return this.value
    }
}

class Consumer implements SourceMixin {
    useMixin (): string {
        return super.method()
    }
}
```

The transformer expands mixin classes into an interface, a runtime factory, and a
canonical runtime value. Consumers are compiled through an intermediate base class and
`mixinChain(...)`, so `this`, `super`, statics, `instanceof`, required bases, and generic
`implements` types work across the generated inheritance chain.

Construction is opt-in through `Base`:

```ts
import { Base } from "ts-mixin-class"

class Model extends Base {
    public id: string = ""
}

const model = Model.new({ id : "42" })
```

`constructionConfig: "public-only"` is the default and builds the `new(...)` config type
from explicitly `public` instance fields. `constructionConfig: "instance-type"` uses
the broader `Partial<Consumer<T>>` shape.
