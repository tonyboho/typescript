---
"ts-mixin-class": patch
---

Make `tsc` (emit) flag a `@mixin` class that does not satisfy the contract it
`implements`, matching the IDE / `--noEmit`. The emit path lowers a mixin to a value
cast `const X = defineMixinClass(...) as unknown as <type>`, whose `as unknown as`
double-cast erased the structural check between the runtime mixin body and its
`implements` contracts (and the generated `interface X extends Contract` *inherited* the
contract's members instead of checking the class against them) — so a missing or
mismatched member stayed green under `tsc`/CI while the editor showed it red. The
transformer now emits a type-only conformance assertion
(`MixinImplements<InstanceType<ReturnType<typeof factory>>, Contract>`) for non-generic
mixins, which reports the missing member at the mixin's source line and emits no runtime
code.
