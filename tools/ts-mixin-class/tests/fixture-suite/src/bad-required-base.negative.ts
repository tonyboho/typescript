import { RequiredMixin } from "./mixins.js"

class UnrelatedRequiredConsumerBase {
}

class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
}

void BadRequiredConsumer
