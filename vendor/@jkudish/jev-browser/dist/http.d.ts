import { type McpServer } from "@modelcontextprotocol/server";
export declare function serveHttp(factory: () => McpServer, env?: NodeJS.ProcessEnv): Promise<{
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    url: string;
}>;
