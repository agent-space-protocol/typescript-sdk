// The test fixture served over standard input and output, for the stdio transport test.
import { makeSpace } from "./fixture.ts";

const { space } = makeSpace();
await space.listen("stdio");
process.stdin.on("end", async () => {
  await space.close();
  process.exit(0);
});
