import { startExecutionBackground } from "../src/lib/execution-background";

export default defineBackground(() => {
  startExecutionBackground();
});
