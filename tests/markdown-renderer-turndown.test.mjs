import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurndownMarkdownRenderer,
  normalizeMarkdownInput,
} from '../build/ts/core/markdown-renderer/turndown-renderer.js';

test('turndown renderer converts HTML fragments to stable Markdown', () => {
  const renderer = createTurndownMarkdownRenderer();
  const markdown = renderer.render({
    format: 'html',
    value:
      '<h2>Resumo</h2><p>Texto com <strong>ênfase</strong> e <a href="https://example.com">link</a>.</p><pre><code>const x = 1;</code></pre>',
  });

  assert.match(markdown, /^## Resumo/m);
  assert.match(markdown, /Texto com \*\*ênfase\*\* e \[link\]\(https:\/\/example\.com\)\./);
  assert.match(markdown, /```/);
  assert.match(markdown, /const x = 1;/);
});

test('turndown renderer keeps markdown input as markdown and normalizes text input', () => {
  const renderer = createTurndownMarkdownRenderer();

  assert.equal(
    renderer.render({ format: 'markdown', value: '## Titulo\n\n- item' }),
    '## Titulo\n\n- item',
  );
  assert.equal(
    renderer.render({ format: 'text', value: '  uma linha\r\noutra linha  ' }),
    'uma linha\noutra linha',
  );
  assert.deepEqual(normalizeMarkdownInput(null), { format: 'text', value: '' });
});
