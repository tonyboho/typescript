---
"ts-mixin-class": patch
---

Construction classes are now built only through their generated static `.new(...)`,
and mixins may declare their own constructor.

- **A `@mixin` may declare its own constructor.** The previous unconditional ban is
  lifted — the constructor is preserved and runs during construction. The transformer
  injects a synthetic `super()` so the generated `class extends base` stays a valid
  derived constructor and chains through the linearized bases, so a dependent mixin's
  constructor observes its dependencies' constructor state through that chain.

- **A direct `new X()` on a construction class is now a compile-time error.** Any class
  that derives from the package `Base` — a construction `@mixin` or a construction
  consumer — must be created through its static `.new(...)`. A bare `new` previously
  bypassed `initialize()` with no signal (type or runtime); it now fails to type-check.
  This holds whether or not the class declares its own constructor, and `.new()` still
  runs a declared constructor as its native-construct step. (For a class that declares
  its OWN constructor the ban is enforced on the `tsc`/build plane only — the
  position-preserving editor view cannot flag it without breaking navigation — so a
  build still catches it even when the live editor squiggle does not. A class with no
  own constructor is flagged in both.)

- **Base-less mixins now extend a library-owned `Empty` class** (exported) instead of the
  bare `Object`, so every base-less mixin instance shares one named, identifiable ancestor
  (stable object shape, a single `instanceof` anchor). This is a runtime detail only: the
  requirement constraint stays `Object`, so a base-less mixin still composes over any
  consumer base, and `Empty` descends from `Object`.
