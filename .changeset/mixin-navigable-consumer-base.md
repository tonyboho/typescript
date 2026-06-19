---
"ts-mixin-class": patch
---

Make the base type name navigable in a consumer's `extends` clause for the common case.
Go-to-definition, find-all-references and quickinfo on the base name in `class Consumer
extends Base implements Mixin` now reach the real `class Base` instead of the internal
generated `$base`.

In source view a consumer used to be rewritten to `extends Consumer$base`, with the
generated `$base` reference pinned onto the source base position, so the base name resolved
to the internal helper (empty references/definition, `any` quickinfo). For a well-typed,
**non-generic, non-construction** consumer the transformer now skips that indirection and
re-extends the real base under a single-source cast (`extends (Base as unknown as
AnyConstructor<Base & …mixins> & …statics)`), keeping the real base identifier on its source
position while `super.<mixinMember>`, statics, `implements` and `override` all keep
resolving. Generic consumers, construction-base consumers, and consumers whose code is in
error keep the `$base` rewrite (their instance members / construction wiring / diagnostics
genuinely need it), so navigation on their base name is unchanged.
