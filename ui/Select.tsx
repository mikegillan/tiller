import type { ComponentPropsWithRef } from 'react';
import './select.css';

/** A native select with the shared form-control sizing; labels and layout belong to its caller. */
export function Select({ className, ...props }: ComponentPropsWithRef<'select'>) {
  return <select {...props} className={`select${className ? ` ${className}` : ''}`} />;
}
