---
"ts-mixin-class": patch
---

Report the transformer's structural errors as native TypeScript diagnostics with
our own stable error codes (TS990001–TS990007) instead of encoding them as a
generic **TS2344** ("Type … does not satisfy the constraint `never`") whose text
merely happened to carry our message. Each diagnostic now has a precise span on
the offending source, a clean message, and a durable, filterable code, identical
under `tsc` and in the editor:

- **TS990001** — a `@mixin` `extends` another mixin (use `implements`)
- **TS990002 / TS990003** — an anonymous `@mixin` / anonymous mixin consumer
- **TS990004** — an invalid mixin declaration (abstract / private / `#private` /
  abstract member / missing type annotation / unsupported member)
- **TS990005** — an unsupported consumer base expression (e.g. `extends makeBase()`)
- **TS990006** — a consumed mixin with no runtime value
- **TS990007** — mixins that cannot be C3-linearized (a consumer's `implements`
  or a mixin's own dependencies)

Note: because these are authored after the type checker runs, they can no longer
be silenced with `@ts-expect-error` / `@ts-ignore`. This is intended — they are
structural, hard errors (an unsolvable linearization, for instance, would only
generate a meaningless runtime). Required-base mismatch and static-member
collision remain type-encoded, since deciding whether they fire is the checker's
assignability/type-level judgment.
