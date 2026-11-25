// The test fixture on WebSocket with its record on disk; prints its address. For the restart test.
import { join } from "node:path";
import { SqliteStore } from "../src/space/index.ts";
import { makeSpace } from "./fixture.ts";

const [dir, port] = process.argv.slice(2);
const { space } = makeSpace({ store: new SqliteStore(join(dir, "record.db")) });
const l = await space.listen(`ws://127.0.0.1:${port ?? 0}`);
console.log(l.address);
