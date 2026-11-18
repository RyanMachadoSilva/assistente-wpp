// Conexão com o WhatsApp (Baileys) + roteamento das mensagens para o assistente.
import 'dotenv/config'; // precisa ser o primeiro import: carrega o .env antes dos outros módulos
import http from 'node:http';
import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { responder, resumoDoDia, transcrever, configurarEnvio, PROVEDOR } from './agent.js';
import { USUARIOS, normalizar, porNome } from './usuarios.js';
import { iniciarAgendador } from './scheduler.js';
import { save, usuario } from './db.js';

process.env.TZ ||= 'America/Sao_Paulo';

const makeWASocket = baileys.makeWASocket ?? baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = baileys;
const silencioso = pino({ level: 'silent' });

const MODO_PROPRIO = process.env.MODO_PROPRIO === 'true';

// Integração com o robô de cortes (opcional): ele manda os cortes por aqui e recebe os comandos ok/não/postei.
const TOKEN_ROBO = process.env.TOKEN_ROBO || '';
const ROBO_URL = (process.env.ROBO_URL || 'http://robo:8000').replace(/\/$/, '');
const PORTA_INTERNA = Number(process.env.PORTA_INTERNA || 3100);

// ---------- Quem pode falar com o assistente ----------
const numeroDoJid = (jid) => normalizar(String(jid).split('@')[0].split(':')[0]);

function jidsDaMensagem(m) {
  const k = m.key;
  return [k.remoteJid, k.remoteJidAlt, k.participant, k.participantAlt, k.senderPn].filter(Boolean);
}

/** Descobre qual usuário configurado mandou a mensagem (ou null). */
function identificar(m) {
  const numeros = jidsDaMensagem(m).map(numeroDoJid);
  return USUARIOS.find((u) => numeros.includes(u.numero)) || null;
}

const conteudo = (m) => m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message;

function textoDa(m) {
  const msg = conteudo(m);
  return msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || null;
}

const MAX_AUDIO_SEG = 10 * 60; // áudios maiores que 10 min são recusados

/** Baixa o áudio do WhatsApp e devolve o texto falado. */
async function textoDoAudio(m, audio) {
  const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: silencioso, reuploadRequest: sock.updateMediaMessage });
  return transcrever(buffer, audio.mimetype || 'audio/ogg');
}

// ---------- Fila por conversa (responde uma mensagem de cada vez) ----------
const filas = new Map();
function enfileirar(chatId, tarefa) {
  const anterior = filas.get(chatId) || Promise.resolve();
  const proxima = anterior.then(tarefa).catch((e) => console.error('[erro]', e));
  filas.set(chatId, proxima);
  return proxima;
}

// ---------- WhatsApp ----------
let sock = null;
const idsEnviados = new Set(); // evita responder às próprias mensagens no MODO_PROPRIO

async function enviar(chatId, texto) {
  if (!sock) throw new Error('WhatsApp desconectado');
  const enviada = await sock.sendMessage(chatId, { text: texto });
  if (enviada?.key?.id) {
    idsEnviados.add(enviada.key.id);
    if (idsEnviados.size > 500) idsEnviados.delete(idsEnviados.values().next().value);
  }
}

/** Conversa do WhatsApp de alguém da lista USUARIOS. */
async function jidDe(destino) {
  const perfil = usuario(destino.numero, destino.nome);
  if (perfil.chatId) return perfil.chatId;
  // A pessoa ainda não falou com o assistente: procura o número no WhatsApp.
  const [r] = (await sock?.onWhatsApp(destino.bruto).catch(() => [])) || [];
  if (!r?.exists) throw new Error(`o número de ${destino.nome} não foi encontrado no WhatsApp (confira em USUARIOS)`);
  return r.jid;
}

/** Manda mensagem para alguém da lista USUARIOS (usado pela ferramenta enviar_mensagem). */
async function enviarParaUsuario(destino, texto) {
  const jid = await jidDe(destino);
  await enviar(jid, texto);
  console.log(`[mensagem para ${destino.nome}] ${texto.slice(0, 80)}${texto.length > 80 ? '…' : ''}`);
}
configurarEnvio(enviarParaUsuario);

async function tratarMensagem(m) {
  const chatId = m.key.remoteJid;
  if (!chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') return; // ignora grupos e status
  if (idsEnviados.has(m.key.id)) return;

  let quem;
  if (m.key.fromMe) {
    // No modo próprio, só aceita mensagens que você manda para você mesmo
    if (!MODO_PROPRIO) return;
    const meus = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numeroDoJid);
    if (!meus.includes(numeroDoJid(chatId))) return;
    quem = { numero: 'proprio', nome: process.env.NOME_USUARIO || 'usuário' };
  } else {
    quem = identificar(m);
    if (!quem) {
      console.log(`[ignorado] mensagem de ${jidsDaMensagem(m).join(' / ')} (não está em USUARIOS)`);
      return;
    }
  }

  const texto = textoDa(m);
  const audio = conteudo(m)?.audioMessage;
  if (!texto && !audio) {
    await enviar(chatId, 'Por enquanto eu entendo texto e áudio 🙂');
    return;
  }
  if (audio && Number(audio.seconds) > MAX_AUDIO_SEG) {
    await enviar(chatId, 'Esse áudio é muito longo pra mim. Manda um de até 10 minutos 🙂');
    return;
  }

  const perfil = usuario(quem.numero, quem.nome);
  if (perfil.chatId !== chatId) {
    perfil.chatId = chatId; // conversa usada para lembretes e resumo diário
    save();
  }

  console.log(`[recebido de ${quem.nome}] ${texto ?? `(áudio de ${audio.seconds || '?'}s)`}`);

  const comando = texto && comandoDoRobo(m, texto);
  if (comando) {
    await enfileirar(chatId, async () => {
      const resposta = await falarComRobo(comando);
      if (comando.acao === 'confirmar_limpeza' && resposta.startsWith('✅')) cortesEnviados.clear(); // números recomeçam
      await enviar(chatId, resposta);
      console.log(`[robô] ${comando.acao} ${comando.id ?? ''} -> ${resposta.slice(0, 60)}`);
    });
    return;
  }
  await enfileirar(chatId, async () => {
    await sock.sendPresenceUpdate('composing', chatId).catch(() => {});
    try {
      let pergunta = texto;
      if (!pergunta) {
        const falado = await textoDoAudio(m, audio);
        console.log(`[áudio de ${quem.nome}] ${falado || '(sem fala)'}`);
        if (!falado) {
          await enviar(chatId, 'Não consegui entender esse áudio. Pode mandar de novo?');
          return;
        }
        pergunta = `(áudio) ${falado}`;
      }
      const resposta = await responder(quem.numero, pergunta);
      await enviar(chatId, resposta);
      console.log(`[enviado para ${quem.nome}] ${resposta.slice(0, 80)}${resposta.length > 80 ? '…' : ''}`);
    } catch (e) {
      console.error('[erro ao responder]', e.message || e);
      const aviso =
        e.status === 429
          ? '⏳ Atingi o limite gratuito da IA por agora. Tenta de novo daqui a pouco (o limite diário volta todo dia de manhã).'
          : '⚠️ Tive um problema para responder agora. Tenta de novo em instantes.';
      await enviar(chatId, aviso);
    } finally {
      await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
    }
  });
}

// ---------- Robô de cortes ----------
const cortesEnviados = new Map(); // id da mensagem do vídeo no WhatsApp -> número do corte

/** "ok 12", "não 12", "postei 12" (ou respondendo ao vídeo do corte) e "cortes". */
function comandoDoRobo(m, texto) {
  if (!TOKEN_ROBO) return null;
  const t = texto.trim().toLowerCase();
  if (/^(status (dos )?cortes|cortes|robô|robo)\s*[?!.]?$/.test(t)) return { acao: 'status' };
  if (/^(log|logs)( do robô| do robo)?\s*[?!.]?$/.test(t)) return { acao: 'log' };
  if (/^(diag|diagn[oó]stico)\s*[?!.]?$/.test(t)) return { acao: 'diag' };
  if (/^(limpar|zerar|apagar) (os )?(cortes|v[ií]deos)( da vps)?\s*[?!.]?$/.test(t)) return { acao: 'limpar' };
  if (/^confirmar limpeza\s*[?!.]?$/.test(t)) return { acao: 'confirmar_limpeza' };
  if (/^(corte agora|corta agora|cortar agora|testar corte|simular corte|corta isso|clipa isso|clipa)\s*[?!.]?$/.test(t)) return { acao: 'forcar' };
  const r = t.match(/^(ok|aprova(?:do)?|n[aã]o|descarta|postei|postado)\s*#?(\d+)?\s*[.!]?$/);
  if (!r) return null;
  const citado = conteudo(m)?.extendedTextMessage?.contextInfo?.stanzaId;
  const id = r[2] ? Number(r[2]) : cortesEnviados.get(citado);
  if (!id) return null; // "ok" solto, sem número e sem responder a um corte: conversa normal
  const acao = { aprova: 'ok', aprovado: 'ok', ok: 'ok', descarta: 'nao', 'não': 'nao', nao: 'nao', postado: 'postei', postei: 'postei' }[r[1]];
  return { acao, id };
}

async function falarComRobo(comando) {
  try {
    const r = await fetch(`${ROBO_URL}/comando`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN_ROBO },
      body: JSON.stringify(comando),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await r.json().catch(() => ({}));
    return json.texto || `O robô respondeu com erro ${r.status}.`;
  } catch (e) {
    return `Não consegui falar com o robô de cortes (${e.message}). Ele está rodando?`;
  }
}

/** Porta interna (só na rede do Docker): o robô manda texto ou vídeo para alguém da lista. */
function iniciarPortaInterna() {
  if (!TOKEN_ROBO) return;
  const servidor = http.createServer((req, res) => {
    const responder_ = (codigo, obj) => {
      res.writeHead(codigo, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || req.url !== '/enviar' || req.headers['x-token'] !== TOKEN_ROBO) return responder_(403, { erro: 'proibido' });
    const partes = [];
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > 80 * 1024 * 1024) req.destroy(); // limite de 80 MB
      else partes.push(c);
    });
    req.on('end', async () => {
      try {
        const corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        const destino = porNome(corpo.para || '') || USUARIOS[0];
        if (!destino) return responder_(400, { erro: 'destino não encontrado em USUARIOS' });
        const jid = await jidDe(destino);
        let enviada;
        if (corpo.tipo === 'video' || corpo.tipo === 'documento') {
          const arquivo = Buffer.from(corpo.arquivo_base64 || '', 'base64');
          enviada = await sock.sendMessage(
            jid,
            corpo.tipo === 'video'
              ? { video: arquivo, caption: corpo.legenda || '', mimetype: 'video/mp4' }
              : { document: arquivo, mimetype: 'video/mp4', fileName: corpo.nome || 'corte.mp4', caption: corpo.legenda || '' }
          );
          if (corpo.corte_id && enviada?.key?.id) {
            cortesEnviados.set(enviada.key.id, Number(corpo.corte_id));
            if (cortesEnviados.size > 300) cortesEnviados.delete(cortesEnviados.keys().next().value);
          }
          console.log(`[robô] ${corpo.tipo} enviado para ${destino.nome} (${(arquivo.length / 1e6).toFixed(1)} MB)`);
        } else {
          await enviar(jid, String(corpo.texto || ''));
        }
        responder_(200, { ok: true });
      } catch (e) {
        console.error('[porta interna]', e.message);
        responder_(500, { erro: e.message });
      }
    });
  });
  servidor.listen(PORTA_INTERNA, () => console.log(`Porta interna do robô de cortes ouvindo em ${PORTA_INTERNA}`));
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || 'auth');
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: silencioso,
    browser: ['Assistente', 'Chrome', '1.0'],
    markOnlineOnConnect: false, // não aparece "online" o tempo todo
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscaneie o QR code no WhatsApp: Configurações > Aparelhos conectados > Conectar aparelho\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('✅ Conectado ao WhatsApp. Mande uma mensagem para testar.');
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        console.log('❌ Sessão encerrada no celular. Apague a pasta "auth" e rode de novo para gerar outro QR.');
        process.exit(1);
      }
      console.log('Conexão caiu, reconectando em 5s...');
      setTimeout(conectar, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // No modo próprio, mensagens que você digita no celular podem chegar como "append"
    if (type !== 'notify' && !(MODO_PROPRIO && type === 'append')) return;
    for (const m of messages) {
      // Ignora mensagens antigas (sincronização de histórico ao reconectar)
      const enviadaEm = Number(m.messageTimestamp || 0) * 1000;
      if (enviadaEm && Date.now() - enviadaEm > 2 * 60_000) continue;
      await tratarMensagem(m).catch((e) => console.error('[erro]', e));
    }
  });
}

// ---------- Início ----------
const chaveNecessaria = PROVEDOR === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
if (!process.env[chaveNecessaria]) {
  console.error(`Falta ${chaveNecessaria} no arquivo .env (PROVEDOR=${PROVEDOR})`);
  process.exit(1);
}
console.log(`Assistente iniciando com IA: ${PROVEDOR}`);
if (!USUARIOS.length && !MODO_PROPRIO) {
  console.error('Defina USUARIOS no .env (ex.: USUARIOS=5534999999999:Ryan).');
  process.exit(1);
}

await conectar();
iniciarAgendador(enviar, resumoDoDia);
iniciarPortaInterna();
