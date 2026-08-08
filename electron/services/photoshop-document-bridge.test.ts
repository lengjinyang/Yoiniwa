import { describe, expect, it } from 'vitest';
import { parsePhotoshopDocumentBridgeResponse } from './photoshop-document-bridge';

describe('Photoshop document bridge protocol', () => {
  it('parses a completed response and rejects malformed output', () => {
    expect(parsePhotoshopDocumentBridgeResponse('{"ok":true,"status":"completed","message":"done"}')).toMatchObject({ ok: true, status: 'completed' });
    expect(parsePhotoshopDocumentBridgeResponse('noise')).toMatchObject({ ok: false, status: 'automation-error' });
  });
});
