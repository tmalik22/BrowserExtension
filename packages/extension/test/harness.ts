/**
 * Test harness: exposes the content-script features on window so Playwright can unit-test the
 * outline/find/resolve logic against real pages without loading the extension.
 */
import { buildOutline } from '../src/content/outline.ts';
import { find, formInput, pageText, resolve, describeId, describeFocused, focusedFieldState } from '../src/content/actions.ts';
import { localId } from '../src/content/dom.ts';

(globalThis as any).chrome ??= { runtime: { sendMessage: () => Promise.resolve() } };

function fmt(lines: ReturnType<typeof buildOutline>['lines']): string {
  return lines
    .map((l) => {
      const indent = '  '.repeat(l.depth);
      if (l.role === 'text') return `${indent}text "${l.name}"`;
      return `${indent}${l.role}${l.name ? ` "${l.name}"` : ''}${l.id !== undefined ? ` [L${l.id}]` : ''}${l.props ? ' ' + l.props : ''}`;
    })
    .join('\n');
}

(window as any).__ba = {
  outline: (req: Parameters<typeof buildOutline>[0] = {}) => {
    const r = buildOutline(req);
    return { ...r, text: fmt(r.lines) };
  },
  find,
  formInput,
  pageText,
  resolve,
  describeId,
  describeFocused,
  focusedFieldState,
  idOf: (selector: string) => {
    const el = document.querySelector(selector);
    return el ? localId(el) : -1;
  },
};
