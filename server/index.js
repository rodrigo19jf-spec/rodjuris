import { openDb, getConfig } from './db.js';
import { criarApp } from './app.js';
import { verificarLembretes, verificarTudo } from './monitor.js';
import { chavesVapid } from './notificador.js';

const PORTA = Number(process.env.PORT || 3000);
const ARQUIVO_DB = process.env.DB_FILE || './dados/jurify.db';

const db = openDb(ARQUIVO_DB);
chavesVapid(db); // gera as chaves de push na primeira execução

const app = criarApp(db);
app.listen(PORTA, () => {
  console.log(`Jurify Pessoal rodando em http://localhost:${PORTA}`);
});

// Lembretes: checa a cada minuto.
setInterval(() => {
  verificarLembretes(db).catch((e) => console.error('[lembretes]', e));
}, 60_000);

// Publicações e andamentos: no intervalo configurado (padrão 4h).
async function cicloMonitoramento() {
  try {
    const r = await verificarTudo(db);
    if (!r.emAndamento) {
      console.log(
        `[monitor] ${new Date().toISOString()} — ${r.processos} processo(s), ${r.publicacoes} publicação(ões) e ${r.andamentos} andamento(s) novos${r.erros.length ? `, ${r.erros.length} erro(s)` : ''}`,
      );
      for (const e of r.erros) console.warn('[monitor]', e);
    }
  } catch (e) {
    console.error('[monitor]', e);
  }
  const horas = Math.max(1, Math.min(Number(getConfig(db, 'intervalo_horas', '4')) || 4, 24));
  setTimeout(cicloMonitoramento, horas * 3_600_000);
}
setTimeout(cicloMonitoramento, 30_000);

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    db.close();
    process.exit(0);
  });
}
