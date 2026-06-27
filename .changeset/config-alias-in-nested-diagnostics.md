---
"ts-mixin-class": patch
---

Always name the `<Class>Config` alias in `<Class>.new({ ... })` errors. When a
config mixed required and optional fields, a call missing a required key reported
`... but required in type 'Pick<Class, ...>'` instead of naming the alias; the
generated `<Class>Config` name is now used throughout the message, including the
nested "but required in type ..." line. Quickinfo on such a config also resolves
to its field shape (`{ id: string; label?: string }`) rather than an opaque
`Pick<...> & Partial<...>`. Configs that are entirely required or entirely
optional are unchanged.
