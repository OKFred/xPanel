import { startExecutionProcessor } from "../src/lib/execution-processor.worker";

export default defineUnlistedScript(() => {
  startExecutionProcessor();
});
