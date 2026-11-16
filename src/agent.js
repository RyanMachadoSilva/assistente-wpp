// Cérebro do assistente: IA (Gemini ou Claude) + ferramentas de tarefas, lembretes, rotinas e notas.
import { save, nextId, usuario } from './db.js';
import { DIAS, fmtData, fmtHora, parseLocal } from './tempo.js';

// PROVEDOR=gemini (grátis, com limites) ou PROVEDOR=anthropic (pago, mais confiável)
export const PROVEDOR = (process.env.PROVEDOR || 'gemini').toLowerCase();
const MODELO =
  process.env.MODELO || (PROVEDOR === 'gemini' ? 'gemini-2.5-flash' : 'claude-sonnet-5-5');
const MAX_HISTORICO = 30; // mensagens guardadas por conversa (pares usuário/assistente)
const MAX_PASSOS = 8;     // limite de chamadas de ferramenta por mensagem

// ---------- Ferramentas que a IA pode usar ----------
const ferramentas = [
  {
    name: 'adicionar_tarefa',
    description: 'Adiciona uma tarefa na lista do usuário. Data e hora são opcionais.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD (opcional)' },
        hora: { type: 'string', description: 'HH:MM (opcional)' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'listar_tarefas',
    description: 'Lista tarefas. filtro: pendentes (padrão), hoje, atrasadas ou todas.',
    input_schema: {
      type: 'object',
      properties: { filtro: { type: 'string', enum: ['pendentes', 'hoje', 'atrasadas', 'todas'] } },
    },
  },
  {
    name: 'concluir_tarefa',
    description: 'Marca uma tarefa como feita pelo id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'remover_tarefa',
    description: 'Apaga uma tarefa pelo id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'criar_lembrete',
    description: 'Agenda uma mensagem de lembrete única para uma data e hora.',
    input_schema: {
      type: 'object',
      properties: {
        mensagem: { type: 'string', description: 'Texto que será enviado no lembrete' },
        quando: { type: 'string', description: 'YYYY-MM-DDTHH:MM no horário local' },
      },
      required: ['mensagem', 'quando'],
    },
  },
  {
    name: 'listar_lembretes',
    description: 'Lista lembretes futuros ainda não enviados.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancelar_lembrete',
    description: 'Cancela um lembrete pelo id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'criar_rotina',
    description:
      'Cria um lembrete recorrente (rotina), ex.: beber água, academia, preparar aula. dias: 0=domingo ... 6=sábado.',
    input_schema: {
      type: 'object',
      properties: {
        mensagem: { type: 'string' },
        hora: { type: 'string', description: 'HH:MM' },
        dias: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
      },
      required: ['mensagem', 'hora', 'dias'],
    },
  },
  {
    name: 'listar_rotinas',
    description: 'Lista as rotinas recorrentes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'remover_rotina',
    description: 'Remove uma rotina pelo id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'salvar_nota',
    description:
      'Guarda uma informação permanente sobre o usuário (preferências, horários fixos, pessoas, fatos úteis). Use quando ele pedir para lembrar algo ou contar algo que vai ser útil depois.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  },
  {
    name: 'remover_nota',
    description: 'Apaga uma nota permanente pelo id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
];

// ---------- Execução das ferramentas ----------
function descreverTarefa(t) {
  const quando = [t.data, t.hora].filter(Boolean).join(' ');
  return `#${t.id} ${t.feita ? '[feita] ' : ''}${t.titulo}${quando ? ` (${quando})` : ''}`;
}

function executar(nome, input, u) {
  const db = u; // dados deste usuário
  if (input.id !== undefined) input.id = Number(input.id);
  if (Array.isArray(input.dias)) input.dias = input.dias.map(Number);
  const hoje = fmtData();
  const porId = (lista, id) => lista.findIndex((x) => x.id === id);

  switch (nome) {
    case 'adicionar_tarefa': {
      const t = {
        id: nextId(),
        titulo: input.titulo,
        data: input.data || null,
        hora: input.hora || null,
        feita: false,
        criadaEm: new Date().toISOString(),
      };
      db.tarefas.push(t);
      save();
      return `Tarefa criada: ${descreverTarefa(t)}`;
    }
    case 'listar_tarefas': {
      const filtro = input.filtro || 'pendentes';
      const lista = db.tarefas.filter((t) => {
        if (filtro === 'todas') return true;
        if (t.feita) return false;
        if (filtro === 'hoje') return t.data === hoje;
        if (filtro === 'atrasadas') return t.data && t.data < hoje;
        return true;
      });
      return lista.length ? lista.map(descreverTarefa).join('\n') : 'Nenhuma tarefa encontrada.';
    }
    case 'concluir_tarefa': {
      const t = db.tarefas.find((x) => x.id === input.id);
      if (!t) return `Tarefa #${input.id} não existe.`;
      t.feita = true;
      save();
      return `Concluída: ${descreverTarefa(t)}`;
    }
    case 'remover_tarefa': {
      const i = porId(db.tarefas, input.id);
      if (i < 0) return `Tarefa #${input.id} não existe.`;
      const [t] = db.tarefas.splice(i, 1);
      save();
      return `Removida: ${t.titulo}`;
    }
    case 'criar_lembrete': {
      const quando = parseLocal(input.quando);
      if (!quando) return 'Erro: data/hora inválida. Use YYYY-MM-DDTHH:MM.';
      if (quando <= new Date()) return 'Erro: esse horário já passou.';
      const l = { id: nextId(), mensagem: input.mensagem, quando: input.quando.slice(0, 16), enviado: false };
      db.lembretes.push(l);
      save();
      return `Lembrete #${l.id} agendado para ${l.quando.replace('T', ' ')}.`;
    }
    case 'listar_lembretes': {
      const lista = db.lembretes.filter((l) => !l.enviado).sort((a, b) => a.quando.localeCompare(b.quando));
      return lista.length
        ? lista.map((l) => `#${l.id} ${l.quando.replace('T', ' ')}: ${l.mensagem}`).join('\n')
        : 'Nenhum lembrete agendado.';
    }
    case 'cancelar_lembrete': {
      const i = porId(db.lembretes, input.id);
      if (i < 0) return `Lembrete #${input.id} não existe.`;
      db.lembretes.splice(i, 1);
      save();
      return `Lembrete #${input.id} cancelado.`;
    }
    case 'criar_rotina': {
      if (!/^\d{1,2}:\d{2}$/.test(input.hora)) return 'Erro: hora inválida. Use HH:MM.';
      const r = { id: nextId(), mensagem: input.mensagem, hora: input.hora, dias: [...new Set(input.dias)].sort() };
      db.rotinas.push(r);
      save();
      return `Rotina #${r.id} criada: ${r.mensagem} às ${r.hora} (${r.dias.map((d) => DIAS[d]).join(', ')}).`;
    }
    case 'listar_rotinas': {
      return db.rotinas.length
        ? db.rotinas.map((r) => `#${r.id} ${r.hora} (${r.dias.map((d) => DIAS[d]).join(', ')}): ${r.mensagem}`).join('\n')
        : 'Nenhuma rotina criada.';
    }
    case 'remover_rotina': {
      const i = porId(db.rotinas, input.id);
      if (i < 0) return `Rotina #${input.id} não existe.`;
      db.rotinas.splice(i, 1);
      save();
      return `Rotina #${input.id} removida.`;
    }
    case 'salvar_nota': {
      const n = { id: nextId(), texto: input.texto };
      db.notas.push(n);
      save();
      return `Nota #${n.id} salva.`;
    }
    case 'remover_nota': {
      const i = porId(db.notas, input.id);
      if (i < 0) return `Nota #${input.id} não existe.`;
      db.notas.splice(i, 1);
      save();
      return `Nota #${input.id} removida.`;
    }
    default:
      return `Ferramenta desconhecida: ${nome}`;
  }
}

// ---------- Prompt do sistema ----------
function promptSistema(u) {
  const db = u;
  const agora = new Date();
  const nome = u.nome || 'usuário';
  const notas = db.notas.length ? db.notas.map((n) => `#${n.id} ${n.texto}`).join('\n') : '(nenhuma)';

  return `Você é o assistente pessoal de ${nome}, conversando pelo WhatsApp. Sua função principal é ajudar a organizar a rotina: tarefas, lembretes, rotinas recorrentes e planejamento do dia.

Agora: ${DIAS[agora.getDay()]}, ${fmtData(agora)} ${fmtHora(agora)} (horário de Brasília).

Coisas que você sabe sobre ${nome}:
${notas}

Como agir:
- Responda em português, curto e direto, como numa conversa de WhatsApp. Nada de textão.
- Formatação do WhatsApp: *negrito*, _itálico_, listas com "-" ou números. Não use # nem tabelas.
- Use as ferramentas para criar, listar e alterar tarefas, lembretes e rotinas. Nunca diga que fez algo sem ter chamado a ferramenta.
- Converta datas relativas ("amanhã", "sexta", "daqui 2 horas") usando a data e hora atuais acima.
- Se faltar uma informação essencial (ex.: o horário de um lembrete), pergunte antes de criar.
- Quando ${nome} contar algo que vale lembrar no futuro (horário de trabalho, aulas, preferências), salve como nota.
- Ao listar coisas, mostre o número (#id) para ele poder dizer "conclui a 3".`;
}

// ---------- Conversa ----------
const MAX_TOKENS = 1500;

/** Erro com status HTTP, para o index.js avisar o usuário quando o limite grátis acabar. */
class ErroIA extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

// ---- Claude (Anthropic) ----
let clienteAnthropic = null;
async function conversarClaude(sistema, historico, texto, u) {
  if (!clienteAnthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    clienteAnthropic = new Anthropic(); // usa ANTHROPIC_API_KEY
  }
  const mensagens = [...historico, { role: 'user', content: texto }];
  let resp;
  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    resp = await clienteAnthropic.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system: sistema,
      tools: ferramentas,
      messages: mensagens,
    });
    if (resp.stop_reason !== 'tool_use') break;
    mensagens.push({ role: 'assistant', content: resp.content });
    const resultados = resp.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const { saida, erro } = rodarFerramenta(b.name, b.input || {}, u);
        return { type: 'tool_result', tool_use_id: b.id, content: saida, is_error: erro };
      });
    mensagens.push({ role: 'user', content: resultados });
  }
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ---- Gemini (Google) ----
// Converte o schema das ferramentas para o formato aceito pelo Gemini.
function schemaGemini(s) {
  const out = {};
  for (const k of ['type', 'description', 'enum', 'required']) if (s[k] !== undefined) out[k] = s[k];
  if (s.items) out.items = schemaGemini(s.items);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = schemaGemini(v);
  }
  return out;
}
const declaracoesGemini = ferramentas.map((f) => {
  const d = { name: f.name, description: f.description };
  if (Object.keys(f.input_schema.properties || {}).length) d.parameters = schemaGemini(f.input_schema);
  return d;
});

async function chamarGemini(corpo) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(corpo),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroIA(r.status, `Gemini ${r.status}: ${json.error?.message || r.statusText}`);
  return json;
}

async function conversarGemini(sistema, historico, texto, u) {
  const contents = [
    ...historico.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: texto }] },
  ];
  let partes = [];
  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    const json = await chamarGemini({
      systemInstruction: { parts: [{ text: sistema }] },
      contents,
      tools: [{ functionDeclarations: declaracoesGemini }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    });
    const conteudo = json.candidates?.[0]?.content;
    partes = conteudo?.parts || [];
    const chamadas = partes.filter((p) => p.functionCall);
    if (!chamadas.length) break;
    contents.push(conteudo); // devolve exatamente o que o modelo mandou (inclui assinaturas internas)
    contents.push({
      role: 'user',
      parts: chamadas.map((p) => {
        const { saida } = rodarFerramenta(p.functionCall.name, p.functionCall.args || {}, u);
        return { functionResponse: { name: p.functionCall.name, response: { resultado: saida } } };
      }),
    });
  }
  return partes
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

function rodarFerramenta(nome, input, u) {
  let saida;
  let erro = false;
  try {
    saida = executar(nome, input, u);
  } catch (e) {
    saida = `Erro ao executar ${nome}: ${e.message}`;
    erro = true;
  }
  console.log(`[ferramenta] ${nome}`, JSON.stringify(input), '->', saida);
  return { saida, erro };
}

export async function responder(chave, texto) {
  const u = usuario(chave);
  const historico = u.historico;
  const conversar = PROVEDOR === 'anthropic' ? conversarClaude : conversarGemini;
  const resposta = (await conversar(promptSistema(u), historico, texto, u)) || 'Feito ✅';

  // Guarda só o texto da conversa (não as chamadas de ferramenta) para manter o histórico leve.
  historico.push({ role: 'user', content: texto }, { role: 'assistant', content: resposta });
  while (historico.length > MAX_HISTORICO) historico.splice(0, 2);
  save();

  return resposta;
}

export function resumoDoDia(chave) {
  return responder(
    chave,
    '(Mensagem automática da manhã) Me mande o resumo do dia: tarefas de hoje, tarefas atrasadas e lembretes de hoje. Se não tiver nada, sugira eu planejar o dia. Seja breve e comece com um bom dia.'
  );
}
