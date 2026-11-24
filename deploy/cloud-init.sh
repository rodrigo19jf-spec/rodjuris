#!/bin/bash
# Cole este conteúdo no campo "cloud-init script" ao criar o servidor (Oracle, Vultr, Hostinger...).
# Ele instala o RodJuris automaticamente no primeiro boot.
curl -fsSL https://raw.githubusercontent.com/rodrigo19jf-spec/rodjuris/main/deploy/instalar.sh | bash
