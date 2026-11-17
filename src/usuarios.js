// Lista de pessoas que podem usar o assistente (USUARIOS no .env).

// Números BR às vezes aparecem sem o 9 extra (55 34 9xxxx-xxxx -> 55 34 xxxx-xxxx). Normaliza para comparar.
export function normalizar(numero) {
  const n = String(numero).replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') return n.slice(0, 4) + n.slice(5);
  return n;
}

// USUARIOS=5534999999999:Ryan,5534988888888:Ana   (número:nome, separados por vírgula)
// Compatível com o formato antigo DONO_NUMEROS + NOME_USUARIO.
function lerUsuarios() {
  const lista = (process.env.USUARIOS || process.env.DONO_NUMEROS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return lista.map((item) => {
    const [numero, nome] = item.split(':');
    return {
      numero: normalizar(numero),               // chave interna (sem o 9 extra)
      bruto: String(numero).replace(/\D/g, ''), // como está no .env, para procurar no WhatsApp
      nome: (nome || process.env.NOME_USUARIO || 'usuário').trim(),
    };
  });
}

export const USUARIOS = lerUsuarios();

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Procura um usuário da lista pelo nome (sem diferenciar maiúsculas e acentos). */
export function porNome(nome) {
  const alvo = semAcento(nome);
  return (
    USUARIOS.find((u) => semAcento(u.nome) === alvo) ||
    USUARIOS.find((u) => semAcento(u.nome).startsWith(alvo) || alvo.startsWith(semAcento(u.nome))) ||
    null
  );
}
