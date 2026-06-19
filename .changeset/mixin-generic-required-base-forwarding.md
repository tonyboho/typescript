---
"ts-mixin-class": patch
---

Let a generic `@mixin` class forward its own type parameter into a generic required base
(`@mixin() class M<T> extends Base<T>`). This previously failed to compile in both
transform paths: emit reported `TS2304: Cannot find name 'T'` and source view reported
`TS2562: Base class expressions cannot reference class type parameters`. A required base
with a *concrete* type argument (`extends Base<string>`) already worked.

Both errors came from the single forwarded `T` inside the generated
`RuntimeMixinClass<Base<T>>` marker, which lands in a position that cannot bind it — the
top-level value-cast intersection (emit) and the `$base` base-class expression (source
view). That marker only carries the `[base]` requirement type; the required base is still
enforced by the generated `interface … extends Base`, the `mix` signature, and
consumer-diagnostics. The fix erases references to the mixin's own type parameters inside
that marker to `any`, keeping it well-formed in both paths while leaving non-forwarded
arguments (`Base<string>`) precise. Mixing onto a base that does not satisfy the required
base is still rejected in both paths.
