# NDD Printer M-Manager

Userscript para o **NDD Print Portal 360** (`https://360.nddprint.com/printers`) que adiciona um painel de gestão em massa da lista de impressoras (testado no Violentmonkey).

## Instalação

1. Instale o **[Violentmonkey](https://violentmonkey.github.io/)** pela loja oficial do seu navegador:
   - Chrome e outros baseados em Chromium: [Chrome Web Store](https://chrome.google.com/webstore/detail/violent-monkey/jinjaccalgkegednnccohejagnlnfdag)
   - Microsoft Edge: [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/eeagobfjdenkkddmbclomhiblgggliao)
   - Firefox: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/violentmonkey/)

2. Abra o link abaixo. O Violentmonkey mostra a tela de instalação; confirme em **Instalar**.

   **[Instalar o NDD Printer M-Manager](https://raw.githubusercontent.com/maiconjs/ndd-printer-m-manager/main/ndd-printer-m-manager.user.js)**

3. Acesse `https://360.nddprint.com/printers` (ou recarregue a página). O painel aparece no canto da tela.

### Chrome e Edge (Chromium): liberar a execução de userscripts

Nas versões atuais dos navegadores baseados em Chromium, a extensão só executa scripts depois que a permissão é liberada para ela:

- **Chrome / Edge 138 ou mais recente:** abra os detalhes do Violentmonkey (botão direito no ícone → **Gerenciar extensão**, ou `chrome://extensions` / `edge://extensions` → **Detalhes**) e ative **Permitir scripts de usuário** (*Allow User Scripts*). A opção é por extensão.
- **Versões anteriores à 138, ou se a opção acima não aparecer:** ative o **Modo do desenvolvedor** no canto superior de `chrome://extensions` (ou `edge://extensions`).

Se o painel não aparecer no portal, confira essa permissão primeiro. No Firefox não é necessário.

## Recursos

- **Seleção em massa**: visíveis, todas as páginas, portas USB, impressoras sem fila, por fabricante/modelo, com janela de revisão e filtros por coluna.
- **Contabilização em lote**: status, origem (Padrão do sistema, Física e Lógica, Apenas Lógica, Apenas Física com MF/Client Collector) e forçar cor. Escolher uma origem com o status em "manter" habilita as impressoras desabilitadas na mesma gravação.
- **Coluna Origem**: coleta sob demanda, com cache por cliente conferido pela auditoria do NDD (só relê o que mudou).
- **Lista de séries (contrato)**: carrega `.csv`/`.txt`, compara com todas as impressoras do NDD, destaca as que estão fora da lista e as séries da lista que não existem no NDD.
- **Exclusão em massa**: exclui do Portal 360 o cadastro das impressoras selecionadas. As que estão com a contabilização habilitada (o NDD não permite excluí-las assim) têm a contabilização desabilitada antes, e o script aguarda o NDD liberar cada exclusão.
- **Ambiente**: filas de impressão por impressora e janela de hosts/produtos NDD com situação de comunicação.
- **Grade**: colunas redimensionáveis com larguras lembradas, exportação `.csv` e log persistente até fechar a aba.

## Observações

- Usa a mesma sessão do portal (as chamadas à API são feitas com o login atual); não armazena credenciais.
- Ações que alteram dados (contabilização e exclusão) sempre pedem confirmação e registram o resultado no log.
- Exclusão bloqueada por `@@360PrinterCounterStatusIsEnabled` depende de desabilitar o contador no NDD MPS; não há como fazer isso pelo Portal 360.
