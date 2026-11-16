// Verifica a cada 30s se há lembretes, rotinas ou resumos diários para enviar, para cada usuário.
import { load, save } from './db.js';
import { dentroDaJanela, fmtData, parseLocal } from './tempo.js';

export function iniciarAgendador(enviar, gerarResumo) {
  const rodar = () => tick(enviar, gerarResumo).catch((e) => console.error('[agendador]', e));
  rodar();
  return setInterval(rodar, 30_000);
}

let rodando = false;

async function tick(enviar, gerarResumo) {
  if (rodando) return; // evita duas execuções ao mesmo tempo
  rodando = true;
  try {
    const db = load();
    const agora = new Date();
    const hoje = fmtData(agora);

    for (const [chave, u] of Object.entries(db.usuarios)) {
      if (!u.chatId) continue; // ainda não mandou nenhuma mensagem

      // Lembretes únicos
      for (const l of u.lembretes) {
        const quando = parseLocal(l.quando);
        if (l.enviado || !quando || quando > agora) continue;
        try {
          await enviar(u.chatId, `⏰ *Lembrete:* ${l.mensagem}`);
          l.enviado = true;
          save();
        } catch (e) {
          console.error(`[agendador] falha no lembrete ${l.id} (${u.nome})`, e.message); // tenta de novo depois
        }
      }
      // Limpa lembretes enviados há mais de 7 dias
      const limite = Date.now() - 7 * 864e5;
      u.lembretes = u.lembretes.filter((l) => !l.enviado || (parseLocal(l.quando)?.getTime() ?? 0) > limite);

      // Rotinas recorrentes
      for (const k of Object.keys(u.rotinaExec)) if (!k.endsWith(`:${hoje}`)) delete u.rotinaExec[k];
      for (const r of u.rotinas) {
        const chaveExec = `${r.id}:${hoje}`;
        if (u.rotinaExec[chaveExec] || !r.dias.includes(agora.getDay()) || !dentroDaJanela(r.hora, agora)) continue;
        try {
          await enviar(u.chatId, `🔁 ${r.mensagem}`);
          u.rotinaExec[chaveExec] = true;
          save();
        } catch (e) {
          console.error(`[agendador] falha na rotina ${r.id} (${u.nome})`, e.message);
        }
      }

      // Resumo diário
      const horaResumo = process.env.RESUMO_HORA;
      if (horaResumo && u.resumoUltimo !== hoje && dentroDaJanela(horaResumo, agora)) {
        u.resumoUltimo = hoje;
        save();
        try {
          const texto = await gerarResumo(chave);
          await enviar(u.chatId, texto);
        } catch (e) {
          console.error(`[agendador] falha no resumo de ${u.nome}`, e.message);
        }
      }
    }
  } finally {
    rodando = false;
  }
}
