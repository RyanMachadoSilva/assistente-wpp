// Armazenamento simples em JSON (data/db.json). Cada usuário tem seus próprios dados.
import fs from 'node:fs';
import path from 'node:path';

const ARQUIVO = path.resolve(process.env.DATA_DIR || 'data', 'db.json');

const INICIAL = { seq: 1, usuarios: {} };

const PERFIL = {
  nome: null,
  chatId: null,     // conversa do usuário no WhatsApp
  tarefas: [],      // {id, titulo, data, hora, feita, criadaEm}
  lembretes: [],    // {id, mensagem, quando, enviado}
  rotinas: [],      // {id, mensagem, hora, dias[]}
  notas: [],        // {id, texto}
  historico: [],    // [{role, content}]
  rotinaExec: {},   // "idRotina:YYYY-MM-DD" -> true
  resumoUltimo: null,
};

let dados = null;

export function load() {
  if (dados) return dados;
  try {
    dados = { ...structuredClone(INICIAL), ...JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) };
  } catch {
    dados = structuredClone(INICIAL);
  }
  return dados;
}

export function save() {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
  fs.renameSync(tmp, ARQUIVO); // escrita atômica: não corrompe se o PC desligar no meio
}

export function nextId() {
  return load().seq++;
}

/** Retorna o perfil do usuário, criando se não existir. */
export function usuario(chave, nome) {
  const db = load();
  const u = (db.usuarios[chave] ||= structuredClone(PERFIL));
  for (const [k, v] of Object.entries(PERFIL)) if (!(k in u)) u[k] = structuredClone(v);
  if (nome) u.nome = nome;
  return u;
}
