import { promises as fs } from 'fs';
import { join } from 'node:path';
import { PremiereProUxpBridge } from '../../bridge/uxp.js';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn()
  }
}));

jest.mock('node:crypto', () => ({ randomUUID: jest.fn(() => 'uxp-command-id') }));

describe('PremiereProUxpBridge', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => jest.clearAllMocks());

  it('uses a dedicated UXP queue and unwraps a matching response', async () => {
    const bridgeRoot = '/tmp/premiere-mcp-bridge-test';
    const commandDir = join(bridgeRoot, 'uxp', 'commands');
    const responseDir = join(bridgeRoot, 'uxp', 'responses');
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify({ running: true, timestamp: new Date().toISOString() }))
      .mockResolvedValueOnce(JSON.stringify({
        id: 'uxp-command-id',
        protocolVersion: 1,
        success: true,
        result: { success: true, sequenceName: 'part 2.1', segments: [] }
      }));
    mockFs.unlink.mockResolvedValue(undefined);

    const bridge = new PremiereProUxpBridge(bridgeRoot);
    await bridge.initialize();
    const result = await bridge.execute('read_sequence_transcription', { sequenceId: 'sequence-id' });

    expect(mockFs.mkdir).toHaveBeenCalledWith(commandDir, { recursive: true, mode: 0o700 });
    expect(mockFs.mkdir).toHaveBeenCalledWith(responseDir, { recursive: true, mode: 0o700 });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      join(commandDir, 'command-uxp-command-id.json'),
      expect.stringContaining('"operation":"read_sequence_transcription"')
    );
    expect(result).toEqual({ success: true, sequenceName: 'part 2.1', segments: [] });
    expect(mockFs.unlink).toHaveBeenCalledWith(join(commandDir, 'command-uxp-command-id.json'));
    expect(mockFs.unlink).toHaveBeenCalledWith(join(responseDir, 'response-uxp-command-id.json'));
  });

  it('surfaces a helper-reported error instead of returning a false success', async () => {
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify({ running: true, timestamp: new Date().toISOString() }))
      .mockResolvedValueOnce(JSON.stringify({
        id: 'uxp-command-id', protocolVersion: 1, success: false, error: 'No active sequence.'
      }));
    mockFs.unlink.mockResolvedValue(undefined);

    const bridge = new PremiereProUxpBridge('/tmp/premiere-mcp-bridge-test');
    await bridge.initialize();

    await expect(bridge.execute('read_sequence_transcription', {})).rejects.toThrow('No active sequence.');
  });

  it('fails fast with activation instructions when no fresh UXP heartbeat exists', async () => {
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    const bridge = new PremiereProUxpBridge('/tmp/premiere-mcp-bridge-test');
    await bridge.initialize();

    await expect(bridge.execute('read_sequence_transcription', {})).rejects.toThrow('UXP transcript bridge unavailable');
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
