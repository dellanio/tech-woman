import type { Metadata } from 'next';
import '../../reference.css';
import './globals.css';
export const metadata: Metadata = { title:'Tech Woman — trajetórias que se encontram', description:'Um encontro presencial para mulheres em tecnologia. Inscreva-se e encontre conexões com propósito.' };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="pt-BR" data-theme="dark"><body><a className="skip-link" href="#conteudo">Pular para conteúdo</a>{children}</body></html>; }
