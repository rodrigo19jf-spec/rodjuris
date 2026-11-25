// Servidor "comum" (computador local, VPS, Docker). Na Vercel o ponto de entrada é api/index.js.
import { openDb } from './db.js';
import { criarApp } from './app.js';
import { executarCiclo } from './monitor.js';
import { chavesVapid } from './notificador.js';

const PORTA = Number(process.env.PORT || 3000);

const db = await openDb();
await chavesVapid(db); // gera as chaves de push na primeira execução

const app = criarApp(db);
app.listen(PORTA, () => {
  console.log(`RodJuris rodando em http://localhost:${PORTA}`);
});

// Relógio interno: a cada minuto dispara os lembretes e verifica os processos
// cujo intervalo de monitoramento (padrão 4 h) já passou.
let rodando = false;
async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    const r = await executarCiclo(db);
    if (r.processos || r.lembretes) {
      console.log(
        `[ciclo] ${new Date().toISOString()} — ${r.lembretes} lembrete(s), ${r.processos} processo(s), ${r.publicacoes} publicação(ões) e ${r.andamentos} andamento(s) novos${r.erros?.length ? `, ${r.erros.length} erro(s)` : ''}`,
      );
      for (const e of r.erros || []) console.warn('[monitor]', e);
    }
  } catch (e) {
    console.error('[ciclo]', e);
  } finally {
    rodando = false;
  }
}
setTimeout(ciclo, 15_000);
setInterval(ciclo, 60_000);

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    await db.close();
    process.exit(0);
  });
}
