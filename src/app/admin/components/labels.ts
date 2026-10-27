/** Rótulos legíveis dos valores do domínio para o painel (slugs do banco nunca aparecem crus). */
import { abilities, topics } from '../../shared';
import { GOALS, MOMENTS } from '../../diagnostic';

const LABELS = new Map<string, string>([...topics, ...abilities].map(x => [x.value, x.label]));
export const label = (value: string) => LABELS.get(value) ?? value;
export const labels = (values: string[]) => values.map(label).join(' · ');
export const goalLabel = (value: string) => GOALS.find(g => g.value === value)?.title ?? value;
export const momentLabel = (value: string) => MOMENTS.find(m => m.value === value)?.label ?? value;
/** Área: tema conhecido, "outra" com o texto informado, ou ausência explícita. */
export const areaLabel = (area: string | null, otherArea?: string) => !area ? 'Não informada' : area === 'outra' ? `Outra${otherArea ? `: ${otherArea}` : ''}` : label(area);
/** Razões do servidor: slugs viram rótulos e "(+3)" vira "(+3 pontos)". */
export const reasonLabel = (text: string) => text.replace(/\b[a-z]+\b/g, w => LABELS.get(w) ?? w).replace(/\(\+(\d+)\)/g, '(+$1 pontos)');
