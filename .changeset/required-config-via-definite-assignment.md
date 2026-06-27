---
"ts-mixin-class": patch
---

Mark a required construction-config key with the definite-assignment `!`. A public
field declared `id!: T` is a required key in the generated `<Class>Config`; every
other public field is optional. The `!` reads as "supplied from outside" — exactly
what `.new({ ... })` provides — and lets the field skip an initializer without a
strict property-initialization error. A `!` field may still carry a default
(`id!: T = ...`), even though TypeScript normally forbids `!` together with an
initializer: the default is applied during construction while `.new({ ... })` still
requires the key.
