import { useEffect, useState } from 'react';

/** Follows the OS colour scheme. The canvas needs the value as a boolean, not
 *  as a CSS class, so this cannot be left entirely to Tailwind. */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return dark;
}
