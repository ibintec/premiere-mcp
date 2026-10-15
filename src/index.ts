#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { Server, ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { z, type ZodTypeAny } from 'zod';
import { PremiereProTools } from './tools/index.js';
import { VISION_TOOLS, executeVisionTool, isVisionTool } from './tools/vision.js';
import { PremiereProResources } from './resources/index.js';
import { PremiereProPrompts } from './prompts/index.js';
import { PremiereProBridge } from './bridge/index.js';
import { PremiereProUxpBridge } from './bridge/uxp.js';
import { Logger } from './utils/logger.js';

type ObjectJsonSchema = Record<string, unknown> & { type: 'object' };

class MCPPremiereProServer {
  private stdioHandle?: StdioServerHandle;
  private tools: PremiereProTools;
  private resources: PremiereProResources;
  private prompts: PremiereProPrompts;
  private bridge: PremiereProBridge;
  private uxpBridge: PremiereProUxpBridge;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('MCPPremiereProServer');

    this.bridge = new PremiereProBridge();
    this.uxpBridge = new PremiereProUxpBridge(this.bridge.getTempDirectory());
    this.tools = new PremiereProTools(this.bridge, this.uxpBridge);
    this.resources = new PremiereProResources(this.bridge);
    this.prompts = new PremiereProPrompts();
  }

  private buildServer(): Server {
    const server = new Server(
      {
        name: '@ibintec/premiere-mcp',
        version: '1.3.0-ibintec.1',
        description: 'Ibintec Premiere MCP: Model Context Protocol tools for Adobe Premiere Pro, with vision and title rendering'
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        }
      }
    );

    this.setupHandlers(server);
    return server;
  }

  private inputSchemaToJsonSchema(inputSchema: ZodTypeAny): ObjectJsonSchema {
    const jsonSchema = z.toJSONSchema(inputSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
    if (jsonSchema.type !== 'object') {
      return { type: 'object', additionalProperties: true };
    }
    return jsonSchema as ObjectJsonSchema;
  }

  private setupHandlers(server: Server): void {
    // List available tools
    server.setRequestHandler('tools/list', async () => {
      const tools = [...this.tools.getAvailableTools(), ...VISION_TOOLS].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.inputSchemaToJsonSchema(tool.inputSchema as ZodTypeAny)
      }));
      return { tools };
    });

    // Execute tool calls
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      // Vision tools return images, so they bypass the JSON-text wrapping below.
      if (isVisionTool(name)) {
        const visionResult = await executeVisionTool(name, args || {}, (toolName, toolArgs) =>
          this.tools.executeTool(toolName, toolArgs)
        );
        return server.projectCallToolResult(visionResult as CallToolResult, undefined);
      }

      try {
        const result = await this.tools.executeTool(name, args || {});
        const toolResult: CallToolResult = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result as Record<string, unknown>,
          isError: result.success === false
        };
        return server.projectCallToolResult(toolResult, undefined);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Tool execution failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to execute tool '${name}': ${errorMessage}`
        );
      }
    });

    // List available resources
    server.setRequestHandler('resources/list', async () => {
      return {
        resources: this.resources.getAvailableResources()
      };
    });

    // Read resource content
    server.setRequestHandler('resources/read', async (request) => {
      const { uri } = request.params;
      
      try {
        const resource = this.resources.getResource(uri);
        if (!resource) {
          throw new Error(`Resource '${uri}' not found`);
        }
        const content = await this.resources.readResource(uri);
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              text
            }
          ]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Resource read failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to read resource '${uri}': ${errorMessage}`
        );
      }
    });

    // List available prompts
    server.setRequestHandler('prompts/list', async () => {
      return {
        prompts: this.prompts.getAvailablePrompts()
      };
    });

    // Get prompt content
    server.setRequestHandler('prompts/get', async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        const prompt = await this.prompts.getPrompt(name, args || {});
        return {
          description: prompt.description,
          messages: prompt.messages
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Prompt generation failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to generate prompt '${name}': ${errorMessage}`
        );
      }
    });

    // Error handling
    server.onerror = (error) => {
      this.logger.error('Server error:', error);
    };
  }

  async start(): Promise<void> {
    try {
      await Promise.all([this.bridge.initialize(), this.uxpBridge.initialize()]);
      this.logger.info('Adobe Premiere Pro bridge initialized');
      
      this.stdioHandle = serveStdio(() => this.buildServer(), {
        onerror: (error) => {
          this.logger.error('Stdio transport error:', error);
        }
      });
      
      this.logger.info('MCP Adobe Premiere Pro Server started successfully');
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.stdioHandle?.close();
      await Promise.all([this.bridge.cleanup(), this.uxpBridge.cleanup()]);
      this.logger.info('MCP Adobe Premiere Pro Server stopped');
    } catch (error) {
      this.logger.error('Error stopping server:', error);
      throw error;
    }
  }
}

// Start the server
const server = new MCPPremiereProServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

// Start the server
server.start().catch((error) => {
  console.error('Failed to start MCP Adobe Premiere Pro Server:', error);
  process.exit(1);
}); 
