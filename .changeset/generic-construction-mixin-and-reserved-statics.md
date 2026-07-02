---
"ts-mixin-class": patch
---

Generic construction mixins get a typed `.new<T>`; `mix`/`new` are reserved statics on a mixin.

- **A GENERIC construction-base mixin (`@mixin() class Stash<T> extends Base`) now has the full
  construction surface**: the standalone `.new<T>(props: <Mixin>Config<T>): Mixin<T>` (explicit
  type argument or inferred from the config), the generic `<Mixin>Config<T>` alias in
  declarations, and the direct-`new` ban (a branded generic construct signature) — in both
  planes. Previously the generic form was excluded from construction entirely: `.new` fell back
  to the untyped inherited `Base.new` (or did not resolve at all in emit).
- **`static mix` and `static new` on a `@mixin` are reserved names**, rejected with a clean
  native diagnostic: `.mix(base)` is the framework's application method installed on every mixin
  value, `.new(...)` is the construction protocol. Plain classes and CONSUMERS are unrestricted:
  a user's own `static new` overrides the generated factory (the transform skips generating its
  own), and a consumer's `static mix` is an ordinary user static — the framework `.mix` is now
  excluded from the consumer's inherited statics bag (it lives on mixin values only and never
  existed on consumers at runtime; carrying it in the type also made a user `static mix` an
  inexplicable TS2417).
