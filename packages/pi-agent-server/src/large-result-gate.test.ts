import { describe, expect, it } from 'bun:test';
import type { PiLargeResultGateRequest } from '../../shared/src/agent/backend/pi/protocol.ts';
import { createLargeResultGateClient, LARGE_RESULT_GATE_TEXT_CHARS } from './large-result-gate.ts';

const input = { text: 'y'.repeat(LARGE_RESULT_GATE_TEXT_CHARS + 500), context: { toolName: 'bash', intent: 'list files' }, estimatedTokens: 30_000 };

describe('Pi large-result gate client', () => {
  it('asks the main process with the start of the result and returns its answer', async () => {
    const sent: PiLargeResultGateRequest[] = [];
    const client = createLargeResultGateClient((request) => sent.push(request));
    const answer = client.gate(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'large_result_gate_request', toolName: 'bash', intent: 'list files', estimatedTokens: 30_000 });
    expect(sent[0]!.text.length).toBe(LARGE_RESULT_GATE_TEXT_CHARS);
    client.handleResponse('unrelated', false);
    client.handleResponse(sent[0]!.requestId, false);
    expect(await answer).toBe(false);
    // A late duplicate reply is ignored.
    client.handleResponse(sent[0]!.requestId, true);
  });

  it('counts a reply that never comes as no answer', async () => {
    const client = createLargeResultGateClient(() => {}, 10);
    expect(await client.gate(input)).toBeNull();
  });
});
