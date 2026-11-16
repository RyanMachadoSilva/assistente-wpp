export const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const p = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD no fuso local */
export function fmtData(d = new Date()) {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** HH:MM no fuso local */
export function fmtHora(d = new Date()) {
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Converte "YYYY-MM-DDTHH:MM" (hora local) em Date. Retorna null se inválido. */
export function parseLocal(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return null;
  const d = new Date(str.slice(0, 16)); // sem fuso = hora local
  return Number.isNaN(d.getTime()) ? null : d;
}

/** true se "agora" está entre HH:MM e HH:MM + janelaMin minutos */
export function dentroDaJanela(hhmm, agora = new Date(), janelaMin = 5) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return false;
  const alvo = Number(m[1]) * 60 + Number(m[2]);
  const atual = agora.getHours() * 60 + agora.getMinutes();
  return atual >= alvo && atual < alvo + janelaMin;
}
