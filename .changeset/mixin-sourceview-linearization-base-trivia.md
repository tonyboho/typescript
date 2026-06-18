---
"ts-mixin-class": patch
---

Fix the last source-view trivia crash ("Did not expect <kind> to have an
Identifier in its trivia") — a consumer whose mixins fail C3 linearization built
its diagnostic `$base` interface/class with the throwaway emit range, so the
cloned heritage's source positions expanded the helper over the consumer and
stranded its name. The diagnostic path now routes the `$base` declarations through
the source-view range mapper, matching the normal consumer path.
