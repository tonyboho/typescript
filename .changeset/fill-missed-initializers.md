---
"ts-mixin-class": patch
---

Add the `fillMissedInitializersWith` compiler-plugin option. For classes that
extend `Base` (directly or transitively), every instance field left without an
initializer is given an explicit default in the emitted code, so each instance
keeps a stable object shape (monomorphic property access in V8). The fill uses a
non-null assertion (`undefined!` / `null!`), so the field's declared type is never
widened.

Three modes: `"undefined"` (default), `"null"`, and `"nothing"` (off). The fill
applies to fields of every visibility — public, protected, private, or unmarked —
and only where no initializer was written: a field with an explicit initializer is
left untouched, so `public id: number = undefined` stays a type error.
