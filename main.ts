import express from "express";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import z from "zod";
import process from "node:process";

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: "ts-deno-mcp-poc", lowestLevel: "debug", sinks: ["console"] },
  ],
});

const logger = getLogger(["ts-deno-mcp-poc", "main"]);

const proper404Client = Boolean(process.env.PROPER_404_CLIENT) || false;

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports = {
  streamable: {} as Record<string, StreamableHTTPServerTransport>,
  sse: {} as Record<string, SSEServerTransport>,
};

app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.info(`Received request: ${req.method} ${req.url}`);
    logger.info(`Request body: ${JSON.stringify(req.body, null, 2)}`);
    next();
  },
);

const server = new McpServer({
  name: "ts-deno-mcp-poc",
  version: "0.1.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo Tool",
    description: "Echoes back the provided message",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `Tool echo: ${message}` }],
  }),
);

server.registerResource(
  "echo",
  new ResourceTemplate("echo://{message}", { list: undefined }),
  {
    title: "Echo Resource",
    description: "Echoes back messages as resources",
  },
  async (uri: { href: any }, { message }: any) => ({
    contents: [{
      uri: uri.href,
      text: `Resource echo: ${message}`,
    }],
  }),
);

const setupSession = async (
  sessionId: string | undefined,
): Promise<StreamableHTTPServerTransport> => {
  if (sessionId) {
    logger.info(
      `sessionId passed but it dont exists, try to create a new one with existing sessionId ${sessionId}`,
    );
  } else {
    logger.info(`creating a new session with sessionId ${sessionId}`);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId || crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      // Store the transport by session ID
      logger.info(`Session initialized with ID: ${sessionId}`);
      transports.streamable[sessionId] = transport;
    },
    // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
    // locally, make sure to set:
    // enableDnsRebindingProtection: true,
    // allowedHosts: ['127.0.0.1'],
  });

  // Clean up transport when closed
  transport.onclose = () => {
    if (transport.sessionId) {
      delete transports.streamable[transport.sessionId];
    }
    server.close();
    logger.info(`Transport closed for session: ${transport.sessionId}`);
  };

  // Connect to the MCP server
  await server.connect(transport);

  return transport;
};

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req: express.Request, res: express.Response) => {
  logger.info("Received POST request");

  // Check for existing session ID
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.streamable[sessionId]) {
    logger.info(`Reusing existing session: ${sessionId}`);
    // Reuse existing transport
    transport = transports.streamable[sessionId];
  } else if (
    sessionId && !transports.streamable[sessionId] && proper404Client
  ) {
    res.status(404).send(`sessionId ${sessionId} not found`);
    return;
  } else if (isInitializeRequest(req.body)) {
    transport = await setupSession(sessionId);
  } else {
    transport = await setupSession(sessionId);

    await transport.handleRequest(req, res, [{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {
          "roots": {
            "listChanged": true,
          },
          "sampling": {},
          "elicitation": {},
        },
        "clientInfo": {
          "name": "ExampleClient",
          "title": "Example Client Display Name",
          "version": "1.0.0",
        },
      },
    }]);
  }

  // if (!transports.streamable[sessionId ?? ""]) {
  //   await transport.handleRequest(req, res, [{
  //     "jsonrpc": "2.0",
  //     "id": 1,
  //     "method": "initialize",
  //     "params": {
  //       "protocolVersion": "2024-11-05",
  //       "capabilities": {
  //         "roots": {
  //           "listChanged": true,
  //         },
  //         "sampling": {},
  //         "elicitation": {},
  //       },
  //       "clientInfo": {
  //         "name": "ExampleClient",
  //         "title": "Example Client Display Name",
  //         "version": "1.0.0",
  //       },
  //     },
  //   }]);
  // }

  // Handle the request
  await transport.handleRequest(req, res, req.body);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (
  req: express.Request,
  res: express.Response,
) => {
  logger.info("Received request for session handling");
  logger.info(`Request method: ${req.method}`);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  logger.info(`sessionId ${sessionId}`);

  if (!sessionId || !transports.streamable[sessionId]) {
    res.status(404).send("Invalid or missing session ID");
    //https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management
    return;
  }

  const transport = transports.streamable[sessionId];
  await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", handleSessionRequest);

// Handle DELETE requests for session termination
app.delete("/mcp", handleSessionRequest);

app.listen(3000, () => {
  logger.info("Server is running on http://localhost:3000");
});
