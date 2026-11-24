// Testa a conexão com as APIs do CNJ a partir deste servidor.
// Uso: node server/diagnostico.js [numero-do-processo]
import { testarConexoes } from './fontes.js';
import { cnjValido, formatarCnj, somenteDigitos } from './cnj.js';

const numero = somenteDigitos(process.argv[2] || '00008323520184013202');
if (!cnjValido(numero)) {
  console.error('Número de processo inválido.');
  process.exit(2);
}
console.log(`\nTestando as APIs do CNJ com o processo ${formatarCnj(numero)}...\n`);
const resultados = await testarConexoes(numero);
for (const r of resultados) console.log(`${r.ok ? '✅' : '❌'} ${r.fonte}: ${r.mensagem}`);
const falhou = resultados.some((r) => !r.ok);
console.log(falhou ? '\nAlgum teste falhou (veja acima).\n' : '\nTudo certo! O servidor consegue falar com o CNJ.\n');
process.exit(falhou ? 1 : 0);
