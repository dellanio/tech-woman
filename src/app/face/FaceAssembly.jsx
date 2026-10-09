'use client';
import { useEffect, useRef } from 'react';
import { createFaceAssembly } from './motion.mjs';
import { encodedPoints, metadata } from './dados.mjs';
import './face-assembly.css';

/* Adaptador para o builder. Só o hero usa este componente; as artes das outras
   rotas continuam estáticas. SSR emite o WebP final, nunca um canvas vazio sozinho. */
export default function FaceAssembly({
  darkSrc = '/arte/perfil-1.webp',
  lightSrc = '/arte/perfil-1-claro.webp',
}) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  useEffect(() => {
    const stage = stageRef.current;
    const assembly = createFaceAssembly({
      stage,
      canvas: canvasRef.current,
      images: stage.querySelectorAll('.face-final'),
      encodedPoints,
      metadata,
      diagnostics: false,
    });
    return () => assembly.dispose();
  }, [darkSrc, lightSrc]);
  return <div className="face-stage" ref={stageRef} aria-hidden="true">
    <img className="face-final face-dark" src={darkSrc} width={1400} height={1400}
      alt="" decoding="async" loading="eager" fetchPriority="high" />
    <img className="face-final face-light" src={lightSrc} width={1400} height={1400}
      alt="" decoding="async" loading="eager" />
    <canvas className="face-canvas" ref={canvasRef} hidden />
  </div>;
}
