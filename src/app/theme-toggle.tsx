'use client';
import { useEffect, useState } from 'react';

/** Controle das telas internas: sem dependência da arte/motion da home. */
export function ThemeButton() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem('tw-theme') === 'light';
    document.documentElement.dataset.theme = saved ? 'light' : 'dark';
    setLight(saved);
  }, []);
  return <button className="theme-toggle" type="button" onClick={() => {
    const next = !light;
    setLight(next);
    document.documentElement.dataset.theme = next ? 'light' : 'dark';
    localStorage.setItem('tw-theme', next ? 'light' : 'dark');
  }} aria-label={light ? 'Ativar tema escuro' : 'Ativar tema claro'}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={light ? 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.461.402.805a6.5 6.5 0 0 0 8.267 8.266c.345-.214.826-.003.804.401Z' : 'M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'}/></svg>
    <span>{light ? 'Escuro' : 'Claro'}</span>
  </button>;
}
