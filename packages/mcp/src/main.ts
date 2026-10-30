import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findRoot } from "./root.js";
import { createServer } from "./server.js";

const server = createServer(findRoot(process.argv.slice(2), process.env, process.cwd()));
await server.connect(new StdioServerTransport());
