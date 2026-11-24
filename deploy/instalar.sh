#!/usr/bin/env bash
# Instala (ou atualiza) o RodJuris num servidor Ubuntu/Debian.
# Uso, como root:
#   curl -fsSL https://raw.githubusercontent.com/rodrigo19jf-spec/rodjuris/main/deploy/instalar.sh | bash
# Para usar um domínio próprio: ... | DOMINIO=meudominio.com.br bash
set -euo pipefail
exec > >(tee -a /var/log/rodjuris-instalacao.log) 2>&1

REPO="${REPO:-https://github.com/rodrigo19jf-spec/rodjuris.git}"
PASTA="/opt/rodjuris"

msg() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root (ou com sudo)."; exit 1; fi

msg "Atualizando o sistema e instalando ferramentas básicas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
timedatectl set-timezone America/Sao_Paulo 2>/dev/null || true

# Servidores de 1 GB: um pouco de memória extra (swap) evita travamentos na instalação.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 2000 ]; then
  msg "Criando 1 GB de memória extra (swap)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null 2>&1; then
  msg "Instalando o Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  msg "Liberando as portas 80 e 443 no firewall"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# Imagens Ubuntu da Oracle Cloud vêm com regras de iptables que bloqueiam tudo além do SSH.
if command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  msg "Liberando as portas 80 e 443 no firewall interno (iptables)"
  for porta in 80 443; do
    iptables -C INPUT -p tcp --dport "$porta" -m state --state NEW -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 1 -p tcp --dport "$porta" -m state --state NEW -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi

if [ -d "$PASTA/.git" ]; then
  msg "Atualizando o código"
  git -C "$PASTA" pull --ff-only
else
  msg "Baixando o código"
  git clone --depth 1 "$REPO" "$PASTA"
fi
mkdir -p "$PASTA/dados"

IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
if [ -z "${DOMINIO:-}" ]; then
  if [ -f "$PASTA/.dominio" ]; then DOMINIO="$(cat "$PASTA/.dominio")"; else DOMINIO="${IP//./-}.sslip.io"; fi
fi
echo "$DOMINIO" > "$PASTA/.dominio"

msg "Subindo o RodJuris (a primeira vez leva alguns minutos)"
cd "$PASTA/deploy"
DOMINIO="$DOMINIO" docker compose up -d --build

msg "Testando a conexão com o CNJ a partir deste servidor"
sleep 3
docker compose exec -T app node server/diagnostico.js || true

cat <<FIM

============================================================
 RodJuris instalado!

 Endereço:  https://$DOMINIO
 (o certificado HTTPS pode levar 1 minuto para ficar pronto)

 Para atualizar no futuro, rode o mesmo comando de novo.
 Seus dados ficam em: $PASTA/dados  (faça backup dessa pasta)
============================================================
FIM
