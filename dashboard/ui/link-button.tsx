/** A link that looks like a button. */
import type {ReactNode} from 'react';
import {Button} from './core';

export function LinkButton({
  href,
  children,
  variant = 'secondary',
  size = 'sm',
  external,
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'link';
  size?: 'md' | 'sm';
  external?: boolean;
  className?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={href} {...(external ? {target: '_blank', rel: 'noreferrer'} : {})}>
        {children}
      </a>
    </Button>
  );
}
