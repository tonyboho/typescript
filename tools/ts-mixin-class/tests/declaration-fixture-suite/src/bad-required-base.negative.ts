import { RequiredMixin } from "ts-mixin-class-fixture-suite/mixins"

class DeclarationUnrelatedRequiredBase {
}

class DeclarationBadRequiredConsumer extends DeclarationUnrelatedRequiredBase implements RequiredMixin {
}

void DeclarationBadRequiredConsumer
