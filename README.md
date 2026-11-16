# Assistente pessoal no WhatsApp

Você conversa com ele pelo WhatsApp em linguagem normal, e ele organiza sua rotina:

- **Tarefas**: "anota que preciso corrigir as provas até sexta"
- **Lembretes**: "me lembra amanhã às 14h de ligar pro meu chefe"
- **Rotinas**: "todo dia útil às 10h me lembra de beber água"
- **Resumo do dia**: toda manhã ele manda as tarefas do dia e as atrasadas
- **Memória**: "guarda que eu trabalho na escola de segunda a quarta de manhã"

Funciona com o **Gemini** (Google, tem plano grátis) ou com o **Claude** (Anthropic, pago). Troca com uma linha no `.env`.

Ele pode ser usado por **mais de uma pessoa** (você e sua namorada, por exemplo). Cada uma tem suas próprias tarefas, lembretes e notas, e uma não vê as da outra. Ele só responde aos números configurados em `USUARIOS` e ignora todo o resto.

---

## 1. O que você precisa

1. **Chave da IA**
   - **Gemini (grátis):** entre em https://aistudio.google.com com sua conta Google > **Get API key** > **Create API key**. Não precisa de cartão. Tem limite de mensagens por dia e, no plano grátis, o Google pode usar as conversas para melhorar os produtos dele.
   - **Claude (pago):** https://console.anthropic.com > API Keys, com créditos pré-pagos.
2. **Um número de WhatsApp para o assistente** (recomendado, veja os avisos abaixo).
3. **Onde rodar:** na VPS com Docker (24h no ar, recomendado) ou no PC com Node.js 20+.

## 2. Rodar na VPS (Docker)

```bash
git clone git@github.com:RyanMachadoSilva/assistente-wpp.git
cd assistente-wpp
cp .env.example .env
nano .env          # preencha GEMINI_API_KEY e USUARIOS
docker compose up -d --build
docker compose logs -f
```

Vai aparecer um **QR code** no log. No celular **do número do assistente**: WhatsApp > Configurações > Aparelhos conectados > Conectar aparelho, e escaneie. Quando aparecer `✅ Conectado`, aperte **Ctrl+C** para sair do log (o assistente continua rodando).

A sessão e os dados ficam no volume `estado` do Docker: atualizar ou reiniciar não pede QR de novo.

| O que | Comando |
|---|---|
| Ver o que está acontecendo | `docker compose logs -f` |
| Reiniciar (depois de mudar o `.env`) | `docker compose up -d --force-recreate` |
| Atualizar o código | `git pull && docker compose up -d --build` |
| Gerar QR de novo (sessão encerrada) | `docker compose down && docker volume rm assistente-wpp_estado && docker compose up -d` |

## 3. Rodar no PC (Node.js)

```bash
npm install
cp .env.example .env     # no Windows: copy .env.example .env
npm start
```

O QR aparece no terminal. A sessão fica na pasta `auth/` e os dados em `data/db.json`.

## 4. Exemplos de uso

```
me lembra daqui 30 min de tirar a roupa da máquina
o que eu tenho pra hoje?
conclui a 3
toda segunda e quarta às 6h30 me lembra de separar o material da escola
quais rotinas eu tenho?
cancela o lembrete do dentista
guarda que minha aula na UFU é terça e quinta à noite
me ajuda a planejar amanhã: tenho estágio de 8h às 14h e preciso estudar 2h
```

## 5. Sem número separado? (modo próprio)

Dá pra rodar no seu próprio WhatsApp: coloque `MODO_PROPRIO=true` no `.env`, escaneie o QR com o seu celular e converse com o assistente na conversa **"Você" / "Mensagem para mim mesmo"**. Ele não responde a nenhuma outra conversa.

## Para adicionar alguém depois

Adicione `,numero:Nome` no fim da linha `USUARIOS` do `.env` e reinicie (`docker compose up -d --force-recreate` na VPS, ou Ctrl+C e `npm start` no PC). Todos os usuários usam a mesma chave da IA, então dividem o limite grátis do Gemini.

## ⚠️ Avisos importantes

- **Biblioteca não oficial.** O projeto usa a Baileys, que se conecta como "WhatsApp Web". O WhatsApp não autoriza isso oficialmente e **pode banir o número**. O risco é baixo para uso pessoal, com poucas mensagens e só para você, mas existe. Por isso o recomendado é usar um **número separado**, e não o seu principal.
- **Rodando no PC, ele precisa ficar ligado** para responder e mandar lembretes (na VPS fica 24h). Lembretes que vencerem com ele desligado são enviados assim que voltar. Rotinas e o resumo só são enviados dentro de uma janela de 5 minutos do horário.
- **Limite grátis do Gemini:** quando acabar, ele avisa no WhatsApp e volta a funcionar no dia seguinte. Se acontecer sempre, troque `MODELO=gemini-2.5-flash-lite` ou passe para o Claude.
- **Não compartilhe** as pastas `auth/` e `data/` nem o `.env`. Elas dão acesso ao WhatsApp e à sua chave da API.

## Problemas comuns

| Problema | Solução |
|---|---|
| Ele não responde | Veja no terminal se aparece `[ignorado] mensagem de ...`. Se aparecer, copie o número/código mostrado e adicione no `USUARIOS` (ex.: `codigo:Nome`) |
| "Sessão encerrada no celular" | Apague a pasta `auth/` e rode `npm start` de novo |
| Erro no `npm install` da Baileys | Confirme que o Node é 20+ (`node --version`) |
| "Atingi o limite gratuito" | Limite diário do Gemini. Espere, use `MODELO=gemini-2.5-flash-lite` ou troque para o Claude |
| Erro 400/403 do Gemini | Chave errada no `.env` (`GEMINI_API_KEY`) |
| Erro 404 do Gemini | Nome do modelo mudou: ajuste `MODELO` |
| Erro 401 da Anthropic | A chave no `.env` está errada |
| Erro 400 de crédito/saldo | Coloque créditos no console da Anthropic |

## Próximos passos (planejados)

- Entender **áudios** (transcrição)
- Integração com **email** (Gmail/Outlook)
- Integração com o **app da escola**, com aprovação antes de responder os pais
- Deploy automático na VPS pelo GitHub Actions
- Canal do **Telegram**
