---
"ts-mixin-class": patch
---

Fix a tsserver crash ("Did not expect <kind> to have an Identifier in its trivia")
when navigating a source file that applies a mixin manually via `Mixin.mix(Base)`.
The source-view `.mix` apply type deep-clones the mixin's member signatures, which
carry the originals' source positions; embedded in the synthetic metadata-base cast
those identifiers stranded in a `SyntaxList` trivia gap and crashed quickinfo/rename.
The apply type is now collapsed to a synthetic range, since it only shapes
`typeof MixinClass` and is never a navigation target.
