---
"ts-mixin-class": patch
---

Collect a construction-base mixin's `new` config from its whole linearized mixin chain, not just its direct `implements` refs. A `@mixin` class that implements another mixin which itself implements a third dropped the deepest mixin's public config from its generated `new`, so `Mixin.new({ deepProp })` failed with "Object literal may only specify known properties". The consumer path already linearized; this brings the mixin construction path in line.
