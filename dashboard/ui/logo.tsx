/** Nocheh's pixel logo: the brain with a visor, and the "nocheh" wordmark. Drawn on a pixel grid, so edges stay crisp. */
import * as React from 'react';
import {cn} from '../lib/utils';

/** Logo colours. They stay the same in light and dark mode. */
const colors = {body: '#B69CF7', fold: '#8A6FDC', visor: '#0B1024', eyes: '#6EE7C8'};

/** The brain on its own, 16 by 14 pixels. Sized by `className`. */
export function LogoMark({className}: {className?: string}) {
  return (
    <svg viewBox="0 0 16 14" shapeRendering="crispEdges" aria-hidden className={cn('h-auto', className)}>
      <path
        fill={colors.body}
        d="M5 0h6v1h-6zM3 1h1v1h-1zM5 1h8v1h-8zM2 2h2v1h-2zM5 2h9v1h-9zM1 3h2v1h-2zM4 3h11v1h-11zM1 4h6v1h-6zM13 4h2v1h-2zM0 5h6v1h-6zM14 5h2v1h-2zM0 6h1v1h-1zM3 6h3v1h-3zM14 6h2v1h-2zM0 7h3v1h-3zM5 7h1v1h-1zM14 7h2v1h-2zM0 8h6v1h-6zM14 8h2v1h-2zM1 9h6v1h-6zM13 9h2v1h-2zM1 10h1v1h-1zM4 10h11v1h-11zM2 11h2v1h-2zM5 11h9v1h-9zM3 12h10v1h-10zM5 13h6v1h-6z"
      />
      <path
        fill={colors.fold}
        d="M4 1h1v1h-1zM4 2h1v1h-1zM3 3h1v1h-1zM1 6h2v1h-2zM3 7h2v1h-2zM2 10h2v1h-2zM4 11h1v1h-1z"
      />
      <path
        fill={colors.visor}
        d="M7 4h6v1h-6zM6 5h8v1h-8zM6 6h1v1h-1zM9 6h2v1h-2zM13 6h1v1h-1zM6 7h1v1h-1zM9 7h2v1h-2zM13 7h1v1h-1zM6 8h8v1h-8zM7 9h6v1h-6z"
      />
      <path fill={colors.eyes} d="M7 6h2v1h-2zM11 6h2v1h-2zM7 7h2v1h-2zM11 7h2v1h-2z" />
    </svg>
  );
}

/** The "nocheh" wordmark in the text colour. */
export function Wordmark({className}: {className?: string}) {
  return (
    <svg viewBox="0 0 46 10" shapeRendering="crispEdges" aria-hidden className={cn('h-auto', className)}>
      <path
        fill="currentColor"
        d="M24 0h2v1h-2zM40 0h2v1h-2zM24 1h2v1h-2zM40 1h2v1h-2zM24 2h2v1h-2zM40 2h2v1h-2zM0 3h5v1h-5zM9 3h4v1h-4zM17 3h5v1h-5zM24 3h5v1h-5zM33 3h4v1h-4zM40 3h5v1h-5zM0 4h6v1h-6zM8 4h6v1h-6zM16 4h6v1h-6zM24 4h6v1h-6zM32 4h6v1h-6zM40 4h6v1h-6zM0 5h2v1h-2zM4 5h2v1h-2zM8 5h2v1h-2zM12 5h2v1h-2zM16 5h2v1h-2zM24 5h2v1h-2zM28 5h2v1h-2zM32 5h2v1h-2zM36 5h2v1h-2zM40 5h2v1h-2zM44 5h2v1h-2zM0 6h2v1h-2zM4 6h2v1h-2zM8 6h2v1h-2zM12 6h2v1h-2zM16 6h2v1h-2zM24 6h2v1h-2zM28 6h2v1h-2zM32 6h6v1h-6zM40 6h2v1h-2zM44 6h2v1h-2zM0 7h2v1h-2zM4 7h2v1h-2zM8 7h2v1h-2zM12 7h2v1h-2zM16 7h2v1h-2zM24 7h2v1h-2zM28 7h2v1h-2zM32 7h2v1h-2zM40 7h2v1h-2zM44 7h2v1h-2zM0 8h2v1h-2zM4 8h2v1h-2zM8 8h6v1h-6zM16 8h6v1h-6zM24 8h2v1h-2zM28 8h2v1h-2zM32 8h6v1h-6zM40 8h2v1h-2zM44 8h2v1h-2zM0 9h2v1h-2zM4 9h2v1h-2zM9 9h4v1h-4zM17 9h5v1h-5zM24 9h2v1h-2zM28 9h2v1h-2zM33 9h5v1h-5zM40 9h2v1h-2zM44 9h2v1h-2z"
      />
    </svg>
  );
}
