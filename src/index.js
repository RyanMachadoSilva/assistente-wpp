// Conexão com o WhatsApp (Baileys) + roteamento das mensagens para o assistente.
import 'dotenv/config'; // precisa ser o primeiro import: carrega o .env antes dos outros módulos
import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { responder, resumoDoDia, PROVEDOR } from './agent.js';
import { iniciarAgendador } from './scheduler.js';
import { save, usuario } from './db.js';

process.env.TZ ||= 'America/Sao_Paulo';

const makeWASocket = baileys.makeWASocket ?? baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const MODO_PROPRIO = process.env.MODO_PROPRIO === 'true';

// ---------- Quem pode falar com o assistente ----------
// Números BR às vezes aparecem sem o 9 extra (55 34 9xxxx-xxxx -> 55 34 xxxx-xxxx). Normaliza para comparar.
function normalizar(numero) {
  const n = String(numero).replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') return n.slice(0, 4) + n.slice(5);
  return n;
}
const numeroDoJid = (jid) => normalizar(String(jid).split('@')[0].split(':')[0]);

// USUARIOS=5534999999999:Ryan,5534988888888:Ana   (número:nome, separados por vírgula)
// Compatível com o formato antigo DONO_NUMEROS + NOME_USUARIO.
function lerUsuarios() {
  const lista = (process.env.USUARIOS || process.env.DONO_NUMEROS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return lista.map((item) => {
    const [numero, nome] = item.split(':');
    return { numero: normalizar(numero), nome: (nome || process.env.NOME_USUARIO || 'usuário').trim() };
  });
}
const USUARIOS = lerUsuarios();

function jidsDaMensagem(m) {
  const k = m.key;
  return [k.remoteJid, k.remoteJidAlt, k.participant, k.participantAlt, k.senderPn].filter(Boolean);
}

/** Descobre qual usuário configurado mandou a mensagem (ou null). */
function identificar(m) {
  const numeros = jidsDaMensagem(m).map(numeroDoJid);
  return USUARIOS.find((u) => numeros.includes(u.numero)) || null;
}

function textoDa(m) {
  const msg = m.message?.ephemeralMessage?.message ?? m.message;
  return msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || null;
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
  if (!texto) {
    await enviar(chatId, 'Por enquanto eu só entendo mensagens de texto 🙂');
    return;
  }

  const perfil = usuario(quem.numero, quem.nome);
  if (perfil.chatId !== chatId) {
    perfil.chatId = chatId; // conversa usada para lembretes e resumo diário
    save();
  }

  console.log(`[recebido de ${quem.nome}] ${texto}`);
  await enfileirar(chatId, async () => {
    await sock.sendPresenceUpdate('composing', chatId).catch(() => {});
    try {
      const resposta = await responder(quem.numero, texto);
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

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || 'auth');
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
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
