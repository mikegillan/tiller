import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select } from './Select';

it('preserves native select semantics, labels, state, events and refs', () => {
  const ref = { current: null };
  const onChange = vi.fn();
  const element = Select({ id: 'choice', name: 'choice', 'aria-describedby': 'help', disabled: true, required: true, value: 'high', ref, onChange, className: 'field', children: <option value="high">High</option> });
  expect(element.type).toBe('select');
  expect(element.props.ref).toBe(ref);
  expect(element.props.onChange).toBe(onChange);
  expect(element.props.className).toBe('select field');
  const html = renderToStaticMarkup(<label htmlFor="choice">Effort{element}</label>);
  expect(html).toContain('for="choice"');
  expect(html).toContain('id="choice"');
  expect(html).toContain('aria-describedby="help"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('required=""');
  expect(html).toContain('<option value="high" selected="">High</option>');
});
