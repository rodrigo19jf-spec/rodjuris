// Ponto de entrada na Vercel: todas as rotas /api/* chegam aqui (veja vercel.json).
import { openDb } from '../server/db.js';
import { criarApp } from '../server/app.js';

let promessa = null;
function obterDb() {
  // Reaproveita a conexão enquanto a função estiver "quente".
  promessa ??= openDb().catch((err) => {
    promessa = null;
    throw err;
  });
  return promessa;
}

export default criarApp(obterDb);
