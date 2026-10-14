import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a collapsed line renders nothing inside it until opened (long turns have hundreds of tool lines)', () => {
  const source = readFileSync(new URL('../src/chat.tsx', import.meta.url), 'utf8');
  assert.match(source, /<div id=\{id\} className="line-detail" hidden=\{!open\}>\{open \? children : null\}<\/div>/);
});
