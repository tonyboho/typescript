---
"ts-mixin-class": patch
---

Precompute C3 linearization at compile time. The mixin order is now resolved once
during compilation and emitted as a compact replay plan, so at runtime the inheritance
chain is assembled by replaying that plan instead of running the full C3 algorithm —
removing the per-declaration linearization cost.

Two compile-time flags (environment variables read by the compiler and baked into the
emitted code) control the behavior:

- `TS_MIXIN_VERIFY_LINEARIZATION` (on by default) — re-checks every replayed order against
  C3 at runtime and throws on a mismatch. Set it to `0` when building for production to
  drop the check.
- `TS_MIXIN_DISABLE_LINEARIZATION_PLAN` — set it to `1` to emit code that ignores the plan
  and runs C3 at runtime instead, as an escape hatch.

Mixin-only linearization conflicts (a `@mixin` class with inconsistent dependency order
and no consumer) are now reported at compile time in both `tsc --noEmit` and emit mode.
