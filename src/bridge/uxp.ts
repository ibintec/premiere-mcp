import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger.js';

export type UxpOperation = 'read_sequence_transcription';

export interface PremiereProUxpTransport {
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  execute<T = any>(operation: UxpOperation, args: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

interface UxpResponse<T = any> {
  id: string;
  protocolVersion: 1;
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * File transport for the UXP-only Premiere APIs. It intentionally has no
 * dependency on the CEP bridge: the two panels consume separate queues below
 * the same user-authorized bridge root.
 */
export class PremiereProUxpBridge implements PremiereProUxpTransport {
  private readonly logger = new Logger('PremiereProUxpBridge');
  private readonly commandDir: string;
  private readonly responseDir: string;
  private readonly statusFile: string;
  private initialized = false;

  constructor(private readonly bridgeRoot: string) {
    this.commandDir = join(bridgeRoot, 'uxp', 'commands');
    this.responseDir = join(bridgeRoot, 'uxp', 'responses');
    this.statusFile = join(bridgeRoot, 'uxp', 'status.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.commandDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.responseDir, { recursive: true, mode: 0o700 });
    this.initialized = true;
    this.logger.info(`UXP command queue ready at ${this.commandDir}`);
  }

  async cleanup(): Promise<void> {
    // The queue belongs to the user-selected bridge root. Never remove it from
    // the MCP server because the UXP panel can still be open.
    this.initialized = false;
  }

  async execute<T = any>(operation: UxpOperation, args: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
    if (!this.initialized) {
      throw new Error('UXP transcript bridge is not initialized. Restart the MCP server.');
    }

    await this.assertHelperIsRunning();

    const id = randomUUID();
    const commandFile = join(this.commandDir, `command-${id}.json`);
    const responseFile = join(this.responseDir, `response-${id}.json`);

    await fs.writeFile(commandFile, JSON.stringify({
      id,
      protocolVersion: 1,
      operation,
      args,
      timeoutMs,
      timestamp: new Date().toISOString()
    }));

    try {
      const response = await this.waitForResponse<T>(responseFile, id, timeoutMs);
      if (!response.success) {
        throw new Error(response.error || 'UXP transcript bridge returned an unknown error.');
      }
      return response.result as T;
    } finally {
      await fs.unlink(commandFile).catch(() => {});
      await fs.unlink(responseFile).catch(() => {});
    }
  }

  private async assertHelperIsRunning(): Promise<void> {
    try {
      const status = JSON.parse(await fs.readFile(this.statusFile, 'utf8')) as { running?: boolean; timestamp?: string };
      const ageMs = status.timestamp ? Date.now() - Date.parse(status.timestamp) : Number.POSITIVE_INFINITY;
      if (status.running === true && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 15000) return;
    } catch (_) {
      // Fall through to the actionable activation error below.
    }
    throw new Error(
      `UXP transcript bridge unavailable. Open Window > UXP Plugins > MCP Transcript Bridge, ` +
      `select ${this.bridgeRoot}, and click Start Bridge.`
    );
  }

  private async waitForResponse<T>(responseFile: string, id: string, timeoutMs: number): Promise<UxpResponse<T>> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = JSON.parse(await fs.readFile(responseFile, 'utf8')) as UxpResponse<T>;
        if (response.id !== id || response.protocolVersion !== 1) {
          throw new Error('UXP transcript bridge returned a response with an invalid protocol envelope.');
        }
        return response;
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('invalid protocol'))) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    throw new Error(
      `UXP transcript bridge stopped responding. Reopen Window > UXP Plugins > MCP Transcript Bridge ` +
      `and click Start Bridge.`
    );
  }
}
