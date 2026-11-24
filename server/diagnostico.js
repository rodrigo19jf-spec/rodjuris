// Testa a conexão com as APIs do CNJ a partir deste servidor.
// Uso: node server/diagnostico.js [numero-do-processo]
import { buscarProcessoDataJud, buscarPublicacoesDjen } from './fontes.js';
import { cnjValido, formatarCnj, somenteDigitos } from './cnj.js';

const PADRAO = '00008323520184013202'; // processo público usado nos exemplos do CNJ (TRF1)
const numero = somenteDigitos(process.argv[2] || PADRAO);
if (!cnjValido(numero)) {
  console.error('Número de processo inválido.');
  process.exit(2);
}

let falhas = 0;
console.log(`\nTestando as APIs do CNJ com o processo ${formatarCnj(numero)}...\n`);

try {
  const desde = new Date(Date.now() - 365 * 86_400_000);
  const pubs = await buscarPublicacoesDjen({ numeroProcesso: numero }, desde, { maxPaginas: 1 });
  console.log(`✅ DJEN (publicações): conectado — ${pubs.length} publicação(ões) no último ano.`);
} catch (err) {
  falhas++;
  console.log(`❌ DJEN (publicações): ${err.message}`);
}

try {
  const dj = await buscarProcessoDataJud(numero);
  console.log(
    dj
      ? `✅ DataJud (andamentos): conectado — ${dj.classe || 'processo encontrado'}, ${dj.movimentos.length} andamento(s).`
      : '✅ DataJud (andamentos): conectado — processo não encontrado na base (pode estar em segredo de justiça).',
  );
} catch (err) {
  falhas++;
  console.log(`❌ DataJud (andamentos): ${err.message}`);
}

console.log(falhas ? '\nAlgum teste falhou (veja acima).\n' : '\nTudo certo! O servidor consegue falar com o CNJ.\n');
process.exit(falhas ? 1 : 0);
