---
"ts-mixin-class": patch
---

Make `tsc` (emit) flag a `@mixin` class that does not satisfy the contract it
`implements`, matching the IDE / `--noEmit`. The emit path lowers a mixin to a value
cast `const X = defineMixinClass(...) as unknown as <type>`, whose `as unknown as`
double-cast erased the structural check between the runtime mixin body and its
`implements` contracts (and the generated `interface X extends Contract` *inherited* the
contract's members instead of checking the class against them) — so a missing or
mismatched member stayed green under `tsc`/CI while the editor showed it red.

The fix puts the mixin's `implements` clause back on the factory's inner runtime class
(`return class extends base implements Contract {…}`). That clause is type-only (erased
in JS, so runtime output is unchanged) but makes the checker verify the *real* body
against each contract. It works uniformly for generic and non-generic mixins (the mixin's
type parameters are in scope inside the factory), and — pinned to the mixin's source name
— emits the same TS2420 the IDE does, on the same source line and column.
