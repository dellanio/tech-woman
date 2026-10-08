import type { Metadata } from 'next';
import '../../reference.css';
import './globals.css';
import '../../bradesco.css';
export const metadata: Metadata = { title:'Tech Woman Bradesco — trajetórias que se encontram', description:'Encontro presencial em 14 de novembro de 2026 para mulheres em tecnologia. Escolha uma mentora com vaga.' };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="pt-BR" data-theme="dark"><body><a className="skip-link" href="#conteudo">Pular para conteúdo</a>{children}</body></html>; }
