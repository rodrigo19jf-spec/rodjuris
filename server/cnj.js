// Utilitários para o número único de processo (Resolução CNJ 65/2008):
// NNNNNNN-DD.AAAA.J.TR.OOOO

const UFS = {
  '01': 'ac', '02': 'al', '03': 'ap', '04': 'am', '05': 'ba', '06': 'ce', '07': 'df',
  '08': 'es', '09': 'go', '10': 'ma', '11': 'mt', '12': 'ms', '13': 'mg', '14': 'pa',
  '15': 'pb', '16': 'pr', '17': 'pe', '18': 'pi', '19': 'rj', '20': 'rn', '21': 'rs',
  '22': 'ro', '23': 'rr', '24': 'sc', '25': 'se', '26': 'sp', '27': 'to',
};

export function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

export function formatarCnj(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 20) return String(valor ?? '');
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
}

/** Valida os dígitos verificadores (módulo 97, ISO 7064). */
export function cnjValido(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 20) return false;
  const n = d.slice(0, 7);
  const dv = d.slice(7, 9);
  const resto = d.slice(9); // AAAA J TR OOOO
  const calc = 98n - (BigInt(n + resto + '00') % 97n);
  return String(calc).padStart(2, '0') === dv;
}

/**
 * Descobre o "alias" do tribunal na API Pública do DataJud a partir do número
 * (segmento J + código TR). Retorna null quando não suportado.
 */
export function aliasDataJud(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 20) return null;
  const j = d[13];
  const tr = d.slice(14, 16);
  const trNum = Number(tr);
  switch (j) {
    case '3': return 'stj';
    case '4': return trNum >= 1 && trNum <= 6 ? `trf${trNum}` : null;
    case '5': return trNum === 0 ? 'tst' : trNum <= 24 ? `trt${trNum}` : null;
    case '6': return trNum === 0 ? 'tse' : UFS[tr] ? `tre-${UFS[tr]}` : null;
    case '7': return 'stm';
    case '8':
      if (tr === '07') return 'tjdft';
      return UFS[tr] ? `tj${UFS[tr]}` : null;
    case '9':
      return { '13': 'tjmmg', '21': 'tjmrs', '26': 'tjmsp' }[tr] ?? null;
    default:
      return null;
  }
}

/** Nome legível do tribunal (ex.: "TJSP", "TRF3", "TRT2"). */
export function siglaTribunal(valor) {
  const alias = aliasDataJud(valor);
  return alias ? alias.toUpperCase() : null;
}
