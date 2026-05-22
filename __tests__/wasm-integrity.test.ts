/**
 * P0.6b — VB.NET WASM grammar integrity.
 *
 * The committed `vbnet.wasm` is a build artifact (compiled from the pinned
 * CodeAnt-AI/tree-sitter-vb-dotnet commit by scripts/build-vbnet-wasm.sh).
 * This pins its SHA-256 so an accidental or unreviewed swap is caught, and
 * proves the self-hosted-WASM loader path actually loads it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  initGrammars,
  loadGrammarsForLanguages,
  getParser,
} from '../src/extraction/grammars';

const WASM_PATH = path.join(__dirname, '..', 'src', 'extraction', 'wasm', 'vbnet.wasm');
const SHA_PATH = `${WASM_PATH}.sha256`;

describe('vbnet.wasm integrity', () => {
  it('matches its committed SHA-256', () => {
    const wasm = fs.readFileSync(WASM_PATH);
    const actual = crypto.createHash('sha256').update(wasm).digest('hex');
    const expected = fs.readFileSync(SHA_PATH, 'utf8').split('\n')[0]!.trim();
    expect(actual).toBe(expected);
  });

  it('records the pinned upstream commit on the second line', () => {
    const commit = fs.readFileSync(SHA_PATH, 'utf8').split('\n')[1]!.trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('self-hosted WASM loader', () => {
  it('loads the vbnet grammar through loadGrammarsForLanguages', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['vbnet']);
    const parser = getParser('vbnet');
    expect(parser).not.toBeNull();
  });

  it('parses a VB.NET module with the loaded grammar', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['vbnet']);
    const parser = getParser('vbnet');
    const tree = parser!.parse('Module M\n  Sub Main()\n  End Sub\nEnd Module');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.namedChildCount).toBeGreaterThan(0);
  });
});
