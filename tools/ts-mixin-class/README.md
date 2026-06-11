# ts-mixin-class

TypeScript program transformer skeleton for class-level mixin decorators.

The package currently exports a runtime no-op marker decorator:

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class Example {}
```

The transformer recognizes marker decorators imported from `ts-mixin-class` and removes
them from the transformed AST. The actual mixin expansion will be added later.
