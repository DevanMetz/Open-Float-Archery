# Recursos disponíveis

Esta página reúne os recursos do OpenFloat Archery que já foram implementados
no firmware e no painel web. Para a arquitetura do sistema, as intenções de
design e os objetivos futuros, consulte [`Blueprint.md`](../../Blueprint.md).
Para começar, veja o [Início rápido](quick-start.md); para os comandos BLE,
consulte a [referência de comandos](reference/ble-commands.md).

---

## Firmware

- O caminho FIFO de registradores brutos da IMU opera o LSM6DS3TR-C a 3332 Hz
  (ODR), lendo por interrupção no nível de marca d'água FIFO de INT1 (P0.02).
  Uma experiência anterior usou o ODR máximo de 6664 Hz, mas o barramento I2C
  de 1 MHz não conseguia esvaziá-lo sem cerca de um estouro FIFO por segundo,
  que corrompia uma amostra a cada ocorrência.
- Cada quadro de saída calcula a média de três amostras brutas (~0,9 ms),
  produzindo cerca de 1110 quadros médios distintos por segundo; não são
  duplicados quadros para preencher a taxa.
- A detecção de disparos persiste o contador acumulado na RRAM (Zephyr
  Settings/ZMS), restaura-o na inicialização e notifica o aplicativo web a cada
  incremento e ao conectar. Corrija pelo BLE com `shotset:<n>` ou zere com
  `shotreset`.
- Correções e reinicializações do contador preservam os IDs de captura,
  inclusive após reinicializações, mantendo o próximo disparo separado dos
  registros anteriores. Configurações antigas do contador migram
  automaticamente; consulte `Blueprint.md` para o registro de oito bytes e as
  notas sobre downgrade do firmware. Valores de disparo malformados são
  rejeitados sem alterar o contador. O contador acumulado sem sinal para em
  `4294967295`, enquanto os IDs de captura continuam avançando.
- IDs de disparo ao vivo e contagens atuais usam metadados de 32 bits, então as
  confirmações continuam correspondendo ao disparo salvo acima de 65.535. Os
  envios armazenados são associados à captura existente e não desfazem uma
  sincronização atual do contador nem uma correção explícita. Atualize o Painel
  antes de gravar este firmware; o Painel atualizado também lê firmware antigo.
  Verificações de C no host, navegador, Python e compilação do SDK passam;
  testes físicos de rollover e reconexão ainda estão pendentes.
- O firmware mantém os 100 registros compactos mais recentes na memória não
  volátil e os envia ao navegador na reconexão. O aplicativo confirma cada
  disparo somente depois de salvá-lo no IndexedDB; então o firmware libera a
  posição armazenada. Todo disparo entra na fila no momento em que é detectado,
  mesmo conectado, para que uma notificação ao vivo perdida possa ser recuperada
  pelo mesmo fluxo de confirmação e nova tentativa, sem reconectar. A gravação
  da fila compacta é adiada por alguns segundos. Confirmações limpam posições
  não utilizadas e preenchimento, e o backend não grava filas vazias
  inalteradas. Depois de salvar uma fila vazia, confirmações rápidas evitam
  outra gravação; alterações na fila, contadores e traçados habilitados ainda
  são gravados de forma independente. O modelo de armazenamento do SDK verifica
  que 100 filas drenadas não geram gravações extras e que a recuperação funciona
  após remontagem. A restauração exige uma leitura completa e um formato
  compatível antes de alterar a RAM. Os dois formatos antigos continuam legíveis,
  preservando ordem e campos; os registros atuais mantêm IDs de captura
  completos. As verificações de migração C para navegador/Python e a compilação
  passam; a verificação de reinicialização física está pendente.
- Traçados de disparo armazenados agora congelam após um atraso configurável de
  pós-disparo (padrão de 1,5 s, ajustado por BLE com `followms:<ms>`), incluindo
  a sustentação antes do disparo e a recuperação depois da soltura. Pontos de
  traçado do firmware e registros `shot_traces` do navegador também armazenam
  amostras do envelope do microfone (`micAmp` por ponto de movimento e uma janela
  `mic_series` em taxa completa nos disparos conectados).
- O padrão de repouso profundo com desconexão em firmware novo é 300 s. Valores
  persistidos podem substituí-lo; atualize o dispositivo com `sleeptime:<s>` ou
  pelo controle de repouso no Painel.
- Antes do repouso automático, o firmware conclui o pós-disparo e verifica se
  as configurações, os disparos enfileirados e os traçados solicitados foram
  salvos. Há até três tentativas; erros persistentes mantêm o sensor ligado e
  adiam o repouso por trinta segundos. Os controles ficam temporariamente
  indisponíveis durante a gravação final. Gravações de traçado com falha podem
  ser tentadas novamente até serem salvas ou sua posição na RAM ser reutilizada.
  Testes de falha no host, armazenamento/remontagem do SDK e compilação passam;
  tempos físicos de repouso/despertar e comportamento da bateria ainda precisam
  ser testados.
- Durante a operação, gravações malsucedidas do contador, da fila de disparos,
  das configurações e dos offsets de calibração recebem até três tentativas,
  separadas por um segundo. Outras configurações prontas ainda podem ser salvas.
  Valores novos substituem gravações pendentes antigas; falhas esgotadas podem
  ser recuperadas após outra atualização ou na gravação final antes do repouso.
  Testes de falha no host, armazenamento/remontagem do SDK e compilação passam;
  a temporização física da gravação e da tarefa ainda precisa de testes.
- Na inicialização, a recuperação do armazenamento termina antes de o sensor
  anunciar ou registrar disparos. Leituras com falha recebem três tentativas.
  Erros persistentes ou contadores/filas salvos malformados impedem a inicialização
  e geram nova tentativa após trinta segundos; enquanto aguarda, o LED pisca
  duas vezes. Configurações ausentes em um dispositivo novo e ajustes
  malformados usam os padrões. Testes de falha de leitura no host, backend do SDK
  e compilação passam; o comportamento físico de inicialização/LED precisa ser
  testado.
- Após a leitura inicial, o firmware procura IDs de captura mais recentes em
  disparos e traçados salvos. Um disparo enfileirado ou traçado completo gravado
  depois do contador pode impedir a reutilização daquele ID após reinicializar.
  A contagem acumulada salva, inclusive correções e zeragens, não muda. Um ID
  recuperado precisa ser salvo antes de o sensor gravar ou reproduzir disparos.
  Reparos com falha seguem a política de novas tentativas da inicialização.
  Verificações no host, ambos os decodificadores clientes e armazenamento/
  remontagem do SDK passam; o comportamento físico após reinicializar ainda
  precisa ser testado. IDs enfileirados antigos de 16 bits não recuperam bits
  superiores ausentes.
- A recuperação de traçado temporizado (`tracetimed`) transporta os 1000 pontos
  com intervalos medidos em milissegundos, referência da soltura, IDs de
  captura completos e validação CRC. A reprodução preserva mudanças de taxa e
  jitter. Intervalos acima de 255 ms iniciam uma nova janela do dispositivo. O
  navegador recorre aos formatos estendidos e antigos sem tempo; gravações
  antigas mantêm a suposição de 52 Hz. Transferência C para JavaScript no host,
  revisão/IndexedDB nativos e compilação NCS passam; temporização no sensor e
  retenção na RRAM ainda precisam de verificação. Gravações completas do
  navegador têm prioridade, e a recuperação sem tempo não substitui uma
  gravação temporizada existente.
- A persistência de traçado completo na RRAM usa blocos de até 512 bytes e um
  manifesto final protegido por CRC, respeitando o limite configurado de 4 KB
  por valor do ZMS. A partição de 64 KB retém até quatro traçados completos; a
  RAM ligada retém dez. Gravações interrompidas descartam o registro temporário
  e preservam os outros três. Na inicialização, registros completos são
  verificados e restaurados na ordem de confirmação. Novas tentativas limitadas
  ocorrem fora do loop da IMU. Testes de falha no host e de capacidade/GC do SDK
  passam; retenção após desligar a alimentação ainda precisa de verificação no
  hardware.
- A configuração padrão do firmware é segura para bateria e desativa o console
  USB UART, permitindo que o XIAO nRF54L15 inicialize com bateria Li-ion. Para
  logs de bancada por USB, compile com o overlay `firmware/prj_uart.conf`.
- Notificações BLE agrupam seis quadros ao vivo de 20 bytes (aceleração de 8
  bits, quaternions integrados e um byte de pico do envelope do microfone) em
  notificações de 120 bytes. Quadros que não são ao vivo — disparo, sincronização
  de contador, estado de armazenamento, disparo salvo e bloco de traçado —
  mantêm o envelope de 29 bytes.
- **Envelope do microfone no chip**: o microfone PDM do XIAO Sense opera a 16 kHz
  em uma tarefa de áudio dedicada. O áudio é lido em blocos de **14 amostras**
  (~1143 atualizações do envelope/s), alinhados ao fluxo IMU/BLE de ~1110 Hz. Um
  seguidor de pico com subtração do ruído de fundo e decaimento de **5 ms**
  codifica um byte de envelope escalonado em cada quadro BLE ao vivo (offset 19,
  divisor de escala 3 no firmware, faixa 0–255), permitindo medir o áudio no
  Painel sem largura de banda adicional.
- A validação mais recente no Windows/Bleak recebeu 28.670 quadros sequenciais
  sem perda de sequência em 25,5 s; excluído o aquecimento, a taxa foi cerca de
  1129 Hz, com zero estouros FIFO, ressincronizações e quadros fora da faixa, e
  100% de quadros distintos (|a| entre 0,814 e 1,179 g).
- A carga da CPU durante o loop acionado por interrupção mediu cerca de 35% em
  atividade e 65% em repouso, abaixo dos ~51% de atividade com consulta contínua.
- **Monitoramento da bateria no chip**: disponibiliza o serviço BLE padrão de
  bateria (BAS, UUID `0x180F`) e a característica Level (`0x2A19`). Mede a
  porcentagem da bateria no pino `P1.14/AIN7_VBAT` (divisor $2.0$), usando o
  regulador com chave dinâmica `vbat_pwr` (`P1.15`) para economizar energia.
- **Calibração da orientação do arco**: permite zerar pitch e roll pelo comando
  BLE `zero` ou pelo botão do Painel. Os offsets são salvos na RRAM de Settings
  (`"cant_offset"`, `"pitch_offset"`) e carregados na inicialização.
- **Ajustes de despertar e repouso**: permite ajustar por BLE a sensibilidade de
  despertar (`wakesens:<g>`), o tempo de repouso profundo (`sleeptime:<s>`) e a
  sensibilidade de movimento durante o repouso (`sleepsens:<g>`); os valores
  ficam na RRAM de Settings.
- **Filtragem da assinatura de recuo**: durante picos de aceleração, verifica a
  magnitude dinâmica quadrada do giroscópio ($\ge 1.5\text{ rad/s}$ /
  $85^\circ\text{/s}$ de velocidade mínima de recuo) para filtrar batidas
  acidentais na flecha, quedas do arco ou quando o dispositivo é pousado.

## Painel do navegador

- As visualizações de calibração ao vivo incluem um nível digital calibrado e
  um visualizador 3D da orientação do arco. Ambos aplicam os offsets de zero
  atuais antes de desenhar, de modo que um arco calibrado corretamente aparece
  nivelado.
- **Processamento da orientação no dispositivo**: consome diretamente os
  quaternions de alta taxa do filtro Madgwick nas notificações BLE, evitando o
  atraso de um filtro complementar no cliente. Valores Euler de roll/pitch/yaw
  são derivados dos quaternions para leituras, entradas do Float Score e
  compatibilidade com traçados salvos antes da migração para quaternions.
- **Medidor acústico ao vivo**: quando conectado, o cabeçalho mostra uma barra
  de clicker/volume, alimentada pelo byte de envelope do microfone do firmware
  em cada quadro ao vivo (~1110/s). O medidor reflete o seguidor de pico no
  dispositivo (decaimento de 5 ms), não áudio PCM bruto.
- A revisão de disparos Pin Float mostra traçados coloridos por fase (verde
  para sustentação de mira, âmbar/vermelho para soltura e cinza para
  pós-disparo), centralizados no ponto de detecção, com o retículo da soltura
  no centro do alvo. O tempo da soltura usa o evento de um traçado automático
  do navegador ou temporizado do firmware, ou um impulso medido acima do limite
  de captura. Sustentações e traçados antigos sem tempo não inventam marcadores
  de soltura ou impacto. A prévia e a linha do tempo compartilham a decisão de
  fase; miniaturas preservam impulsos breves.
- **OpenFloat Float Score**: o navegador calcula uma pontuação de forma
  independente e de código aberto, de 0 a 100, a partir do traçado. Combina
  estabilidade da sustentação, qualidade da soltura, controle do pós-disparo e
  consistência do nível. A versão salva nos disparos é
  `openfloat-float-score-v1`, permitindo comparar alterações futuras com
  segurança. Pontuações aceitam números finitos e strings numéricas entre 0 e
  100. Medidas ausentes ou inválidas aparecem como `--` e não entram em médias,
  classificações ou orientação; zero medido continua válido. Resumos de sessão
  informam quantas capturas têm pontuação, e gráficos preservam lacunas.
  Capturas novas do dispositivo aguardam o próprio traçado do navegador antes
  de exibir pontuações de forma e estabilidade. Traçados recuperados do firmware
  contêm apenas ângulos/áudio e podem ser reproduzidos, mas não recebem a
  pontuação ao vivo do Painel.
- O canvas de revisão mostra também uma elipse de flutuação de 1 sigma, retículo
  da soltura e marcador de reprodução animado. Os controles ficam em seções
  próprias abaixo do alvo, sem sobreposição: faixa Trace Review, controle de
  busca em largura total com botão circular de reproduzir/pausar, linha do tempo
  colorida por fase, velocidade ajustável (0,25×–4×) e zoom no traçado por roda
  do mouse (computador) ou pinça (celular).
- **Traçados de disparos ao vivo**: conectado ao dispositivo, o navegador
  captura o traçado de cada disparo no fluxo ao vivo e o salva pouco depois do
  término do pós-disparo. Capturas conectadas mantêm cerca de 3,5 s de
  sustentação antes do disparo, mais a janela configurada de pós-disparo; o
  buffer móvel de 20 s serve apenas como margem de retenção no navegador.
  Eventos BLE incluem a sequência de amostra ao vivo no momento da detecção,
  alinhando movimento e envelope do microfone à amostra de soltura do dispositivo,
  em vez do horário de chegada da notificação. O firmware congela um traçado na
  RAM por disparo e o persiste quando `bufnvs` está ativo, conectado ou não; a
  recuperação preenche gravações ausentes no navegador.
- **Revisão da sessão**: disparos salvos são agrupados em sessões de treino; cada
  sessão resume Float Score médio, melhor e pior disparo, tendência de
  consistência, disparos por rótulo de exercício e o problema recorrente mais
  importante. Um gráfico compacto mostra a evolução do Float Score.
- **Cartão de pontuação da série**: sessões salvas listam flechas na ordem de
  tiro, agrupadas em séries de três ou seis, com totais por série e total
  acumulado. Flechas sem pontuação mantêm sua posição e são diferentes de
  erros. Toque em uma flecha ou em **Pontuar próxima flecha** para abrir o
  editor; **Salvar e próxima** avança na sessão e **Salvar e concluir** volta a
  Disparos salvos. O tamanho da série é salvo por sessão e incluído nos backups
  locais. Treinos apenas de sustentação não entram no cartão.
- **Resultados das flechas e correlação com a forma**: Trace Review aceita um
  resultado por flecha (`M`, `1`–`10` ou `X`) e, opcionalmente, distância,
  jardas/metros e tamanho do alvo. Os resultados ficam primeiro no dispositivo,
  aparecem nos cartões de disparos recentes/salvos e compõem total, média,
  contagem de 10/X/erros e tendência de pontuação inicial versus final. As
  tendências exigem distância e tamanho do alvo consistentes. Com pelo menos
  seis flechas com resultado e telemetria em uma configuração consistente,
  OpenFloat informa a correlação positiva mais forte entre forma e pontuação,
  com coeficiente e tamanho da amostra, identificando-a como indicação para
  treino, não prova de causalidade. Revisões sem traçado de movimento salvo
  ainda aceitam um resultado. Pontuações ou telemetrias idênticas mantêm a
  contagem de pares, mas não geram correlação; dados de configuração ausentes
  solicitam contexto. Edições de alvo preservam a telemetria mais recente e
  são confirmadas junto da tarefa de envio; falhas de armazenamento preservam
  a pontuação e o impacto anteriores.
- **Gráfico de impacto e análise de agrupamento**: cada flecha revisada pode ser
  posicionada em um alvo normalizado de dez anéis, por mouse/toque ou teclado.
  A posição estima a pontuação, que pode ser corrigida manualmente. Toques e
  marcadores seguem os limites visíveis dos anéis em qualquer tamanho de tela.
  Sessões salvas mostram impactos numerados, centro do grupo, maior distância
  entre pares, distância física quando todas as flechas usam alvo conhecido do
  mesmo tamanho e elipse de um desvio-padrão. Após seis flechas com configuração
  consistente, pode ser exibida uma correlação entre inclinação e eixo
  horizontal, ou pitch e eixo vertical; a interface a apresenta como sinal
  inicial e exige verificações de calibração/configuração antes de usá-la como
  orientação de forma.
- **Indicador de bateria**: quando o dispositivo BLE disponibiliza o serviço de
  bateria padrão, o Painel lê o nível e o exibe no cabeçalho.
- **Indicador de envio de disparos armazenados**: ao reconectar um dispositivo
  que guardou disparos enquanto estava desconectado, aparece o estado
  “Enviando N” ao lado da taxa ao vivo e do contador; ele diminui conforme a
  fila é transferida.
- **Recuperação do link BLE**: se o rádio desconectar, o firmware volta a
  anunciar e o navegador tenta reconectar automaticamente.
  - **Nova tentativa no firmware**: após a desconexão, o firmware agenda o
    anúncio BLE por uma fila de trabalho adiável, após 250 ms; se a pilha não
    estiver pronta, tenta novamente a cada 1000 ms e cancela as tentativas ao
    reconectar.
  - **Limpeza de link inativo**: se um cliente BLE desativar notificações sem
    fechar a conexão, o firmware desconecta a central ociosa após uma breve
    tolerância para voltar a anunciar o sensor.
  - **Reconexão no navegador**: se o link cair inesperadamente, o aplicativo
    mostra `"BLE reconnecting..."` no indicador de estado e tenta conectar até
    seis vezes com espera exponencial (`Math.min(1000 * 2^attempts, 8000)` ms:
    1, 2, 4, 8, 8 e 8 s). Se reconectar, o fluxo ao vivo volta; se todas as
    tentativas falharem, o estado retorna a `"Disconnected"` para que o usuário
    clique no indicador e procure novamente.
  - Desconectar ou escolher outro transporte cancela a configuração pendente e
    invalida comandos antigos. Respostas atrasadas não reativam conexão
    interrompida, aplicam configurações a outro sensor nem desconectam a demo
    ativa. Falhas nas notificações de bateria não interrompem a telemetria ao
    vivo.
  - A reconexão automática também tenta recuperar a reprodução interrompida de
    um disparo salvo, vinculada à captura original, mesmo que o sensor já tenha
    aceitado a confirmação de metadados. Transferências novas descartam blocos
    parciais e ignoram capturas concluídas ou excluídas. A recuperação pendente
    continua até que a reprodução seja salva localmente. Tempos limite da
    transferência ainda permitem reconectar; se o sensor informar que o
    traçado não está disponível, a tentativa termina.
  - Um novo envio também pode tentar recuperar uma reprodução travada na mesma
    conexão; cada solicitação limpa os blocos parciais antigos antes de receber
    novos, preservando a captura original. Desconectar manualmente, trocar o
    transporte ou recarregar a página limpa o contexto da tentativa; o sensor
    ainda precisa reter o traçado para recuperá-lo.
  - Formatos de telemetria desconhecidos não alteram leituras ao vivo nem
    encerram uma recuperação pendente. Testes no navegador cobrem ID de captura
    zero após rollover, incluindo envios duplicados, confirmações e reprodução
    salva; a verificação física de rollover está pendente.
  - Sensores BLE diferentes mantêm capturas e reproduções separados, mesmo
    quando têm o mesmo nome e número de captura. Gravações manuais e
    sustentações Mira Estável mantêm o sensor de origem ao salvar mais tarde.
    Testes no navegador cobrem esses casos; verificação física com vários
    sensores ainda está pendente. Capturas antigas, salvas antes da identificação
    do sensor, continuam em Disparos salvos; o primeiro novo envio pode salvar
    outra cópia. Usar outro navegador ou limpar as permissões Bluetooth também
    pode alterar a identidade do sensor.
  - Os controles de estado do sensor e da nuvem são botões nativos, ativáveis
    pelo teclado, com foco visível e rótulos que acompanham a conexão. As
    configurações da nuvem usam um diálogo nativo com foco de teclado contido,
    fechamento por Escape e retorno do foco ao botão que o abriu.
- **Configurações configuráveis do dispositivo**: a tela Configurações pode
  enviar por BLE comandos de limite, despertar/repouso, buffer de traçado,
  pós-disparo, taxa BLE, buffer NVS e repouso automático. As configurações ficam
  em cache local e são persistidas no dispositivo quando o firmware oferece
  suporte. O firmware rejeita números malformados e limites não finitos antes
  de alterar valores; números válidos fora do intervalo são limitados conforme
  documentado. A restauração exige registros completos e valores compatíveis;
  registros inválidos mantêm os padrões do firmware. Consulte a referência BLE.
- **Gerenciador de perfis de arco**: organiza estabilizadores, potência de
  puxada, velocidade de flecha e notas em perfis personalizados. Salvamentos e
  exclusões são confirmados com suas tarefas de envio pendentes; gravações com
  falha mantêm o formulário para nova tentativa. Ações pendentes evitam envios
  duplicados; carregamentos atrasados não substituem a seleção atual nem um
  rascunho novo, e atualizações preservam edições não salvas. O formulário
  valida os limites exibidos de potência/velocidade. Excluir um perfil mantém
  disparos históricos e atribuições das sessões. Falhas de preferências do
  navegador não transformam uma alteração confirmada em aparente falha.
- **Sessões automáticas de treino**: disparos são agrupados em sessões
  recolhíveis por horário; intervalos maiores que 30 minutos iniciam outra
  sessão. Em Disparos salvos, renomeie uma sessão, atribua o arco e escolha
  séries de três ou seis flechas. Edições preservam as outras configurações,
  acompanham capturas restantes quando o grupo muda durante a edição e são
  confirmadas juntas se o grupo for dividido. Edições pendentes permanecem
  bloqueadas durante atualizações; falhas de leitura/gravação mantêm rascunhos
  para nova tentativa. Um arco histórico indisponível mantém sua atribuição ao
  renomear a sessão. Essas configurações de exibição ficam locais e entram nos
  backups.
- **Revisão de disparos pelo teclado**: capturas recentes, títulos salvos e
  cabeçalhos de sessão usam botões nativos com foco visível. Enter ou Espaço
  abre uma revisão ou expande uma sessão; conteúdo oculto sai da ordem de
  tabulação. Revisar e editar sessões levam o foco aos controles e o devolvem ao
  fechar. A seleção de disparos usa rótulos descritivos nas caixas de seleção
  e anuncia a quantidade; exclusão em lote fica desativada até selecionar algo.
  Exclusões individuais, selecionadas e da demo confirmam juntas capturas,
  traçados e envios pendentes. Nomes de sessões, arcos e tamanho das séries
  acompanham capturas restantes; cartões e dados recentes são atualizados após
  excluir.
  - Envios antigos mantêm suas configurações quando muda a primeira captura da
    sessão. Configurações explícitas na captura que agora inicia a sessão têm
    prioridade; caso contrário, usa-se o contexto salvo mais antigo. A exclusão
    afeta apenas os dados salvos neste navegador; cópias na nuvem não mudam.
  - Novos disparos e traçados atrasados atualizam cartões recentes, métricas do
    histórico e resumos de sessão em ordem de horário. Importações sem data
    aparecem depois das datadas. Atualizações preservam edições de sessão,
    seleções e foco; telemetria atrasada atualiza a revisão ativa sem apagar um
    resultado de flecha incompleto. Abrir um cartão lê os metadados salvos mais
    recentes.
  - Restaurar um backup atualiza revisão e comparação abertas, inclusive
    traçado, microfone, métricas, ordem da sessão e velocidade do arco.
    Formulários de alvo sem edição mostram o resultado restaurado; edições
    inacabadas preservam valores e foco. Gravação inalterada mantém marcadores
    manuais e reprodução; gravação alterada ou ausente substitui o traçado antigo
    e para a reprodução. Um resultado restaurado mais recente prevalece sobre a
    conclusão atrasada de um salvamento anterior, e Salvar e próxima acompanha a
    sessão atual. Atualizações com falha podem ser tentadas de novo sem repetir
    um salvamento confirmado.
  - Outras abas que usam os dados locais atualizam revisões, comparações,
    histórico, arcos e treino adaptativo após alterações confirmadas. Ao voltar
    a uma aba, ela também atualiza se mensagens entre abas não estiverem
    disponíveis. Abas ocultas aguardam até ficarem visíveis; edições inacabadas
    e marcadores de reprodução inalterados são preservados.
- **Gravação manual de traçados longos**: o botão Record, junto ao título
  Traçado do disparo, inicia, encerra e salva capturas de telemetria de duração
  personalizada — útil para gravar séries completas ou exercícios de
  sustentação.
  - A reprodução preserva os tempos medidos das amostras e o alinhamento do
    microfone, reduzindo para cerca de 52 Hz. Fluxos lentos e callbacks atrasados
    mantêm sua duração real; a captura móvel usa uma janela de 30 s. A
    temporização da demo segue os intervalos reais dos callbacks do navegador.
  - Em 1x, a reprodução segue os segundos registrados; pausas e lacunas
    permanecem visíveis no alvo, na orientação do arco e no medidor do microfone.
    Buscar interrompe a reprodução; pausar/retomar usa um único loop de animação,
    e traçados antigos sem tempo mantêm a taxa de amostras estimada. Faixas de
    áudio e marcadores arrastáveis compartilham o intervalo de tempo de
    movimento/áudio nas visualizações Pin Float e Movimento. Movimento mostra
    quaternions, aceleração medida ou ângulos gravados, conforme os dados.
  - Arrastar marcadores e atualizar intervalos responde imediatamente ao
    ponteiro usando a velocidade carregada para a revisão. Mudar o arco ativo
    durante a revisão não altera a estimativa no meio do arraste, e um gesto
    antigo não muda outra captura.
  - Desconectar interrompe a gravação e mantém o botão **Salvar** disponível.
    Falhas mantêm a captura para nova tentativa na aba atual; gravações pendentes
    evitam cliques duplicados ou descarte, e reconectar aguarda que ela seja
    salva ou descartada. Fechar ou recarregar com uma gravação não salva exibe um
    aviso. Após a transação local ser confirmada, a gravação continua salva
    mesmo se uma visualização ou sincronização falhar. Os controles aguardam a
    atualização das telas salvas; uma falha explica como atualizá-las sem salvar
    novamente. Envios em segundo plano permanecem na fila e não bloqueiam a
    próxima gravação.
- **Estimativa acústica de distância**: a revisão procura um possível impacto na
  janela de áudio salva em taxa completa e, para traçados antigos, recorre ao
  áudio dos pontos de movimento. Marcadores preservam o tempo gravado entre as
  amostras. A velocidade do arco atribuída à sessão prevalece sobre o perfil
  selecionado. Velocidade ausente ou inválida usa uma suposição de 280 fps
  claramente identificada; capturas sem arco atribuído que usam o perfil ativo
  o identificam como arco atual. Essa estimativa experimental de som/arrasto
  ainda precisa ser comparada com distâncias reais e nunca preenche a distância
  registrada do alvo.
- **Comparação de disparos na revisão do traçado**: durante a revisão de um
  disparo salvo no alvo Pin Float, use **Comparar com** para sobrepor outro
  disparo no mesmo controle de reprodução. Cada traçado usa sua própria escala
  de movimento e tipo de captura; uma soltura confirmada fica centralizada,
  enquanto sustentações usam sua orientação média.
- **Botão interativo de conexão**: alterne a conexão do sensor no botão de
  estado no canto superior direito do cabeçalho, com clique, Enter ou Espaço.
- **Ajuda de compatibilidade do navegador**: o acesso ao sensor é verificado
  antes que uma tentativa de conexão interrompa a demo ou reinicie uma gravação.
  Navegadores incompatíveis, páginas HTTP comuns e páginas que bloqueiam
  Bluetooth mostram um aviso dispensável com ajuda acessível pelo teclado.
  Demo e ferramentas de dados salvos locais continuam disponíveis. O
  [guia de compatibilidade do Início rápido](quick-start.md#compatibilidade-do-navegador)
  lista plataformas compatíveis, limitações de iPhone/iPad e configuração de
  HTTPS/localhost.
- **Treinador adaptativo**: a aba Treino analisa a estabilidade da sustentação e
  a consistência do nível nas 30 capturas pessoais pontuadas mais recentes.
  Identifica a habilidade mais fraca disponível e recomenda um exercício com
  referência visível e meta cinco pontos maior (máximo 95). Disparos de exemplo,
  sustentações sintéticas de demo e registros sem pontuações utilizáveis não
  entram nessa janela. Recomendações são atualizadas quando traçados atrasados
  adicionam ou corrigem pontuações salvas.
  - Exercícios escolhidos, duração e foco do teclado permanecem; uma sustentação
    iniciada mantém sua regra de pontuação e meta até terminar e salvar. O
    arqueiro pode seguir a recomendação ou escolher Mira Estável, Manter nível
    ou Estabilizar e sustentar. Cada exercício tem regra de pontuação e
    orientação próprias, orientação calibrada, contagem regressiva de preparação
    de 5 s e sustentação de 5 a 30 s. Pin Float ao vivo, elipse sigma, desvios
    cant/pitch e oscilação máxima apoiam a revisão. Traçados salvos preservam os
    tempos e ficam limitados a 52 Hz, mesmo com entrada BLE em taxa completa.
  - Exercício e duração ficam fixos até o resultado ser salvo ou dispensado. A
    preparação usa o tempo decorrido mesmo com callbacks atrasados; a sustentação
    começa com a duração completa quando a orientação aparece. Sair do Treino,
    ocultar a página, mudar a conexão ou perder dados utilizáveis por mais de
    um segundo interrompe a sustentação inacabada e explica como tentar de novo.
    Esse limite é uma proteção de continuidade do navegador que ainda precisa
    ser validada com sensor real. Amostras atrasadas não alteram uma pontuação
    concluída. O horário salvo marca o fim da janela pontuada, mesmo que salvar
    ou tentar novamente ocorra depois. Callbacks atrasados e ajustes do relógio
    após o início não colocam a sustentação em uma sessão futura.
  - Resultados concluídos ficam disponíveis ao trocar de aba ou desconectar,
    redesenham após redimensionar/alterar o tema e avisam antes de recarregar
    quando poderiam ser perdidos. Salvamentos confirmam metadados, reprodução e
    tarefas de envio juntos. Falhas mantêm o resultado para nova tentativa, com
    aviso na tela. Após a confirmação, controles permanecem protegidos durante
    a atualização das telas; falhas informam que o resultado está salvo localmente
    e orientam reabrir Disparos salvos. Um resultado confirmado não pode ser
    salvo outra vez nem gerar aviso de resultado não salvo. Mensagens de
    salvamento preservam o foco e aparecem na tela. Tipo de captura é separado
    do rótulo, mantendo sustentações com nome personalizado fora do cartão de
    pontuação de flechas. Treinos de demo salvos e gravações manuais ficam
    identificados, locais e não alteram a referência pessoal.
- **Personalização 3D da loja de arcos**: a aba Loja de arcos carrega
  `Blender/BowModel.glb` e cria seletores de cor pelos materiais nomeados do
  arco composto no GLB. Os materiais atuais são `string`, `cam`, `riser`,
  `grip` e `text`; as cores ficam em cache local e são aplicadas às prévias 3D
  do Painel e de alinhamento. O GLB também contém um objeto `MCU` nomeado, que
  o aplicativo separa da cena e usa como prévia ao vivo do módulo XIAO.
- **Configurações consolidadas**: cartões de largura total Gerenciamento de
  energia e Telemetria e buffer ficam no topo, seguidos pelo cartão combinado e
  recolhível **Alinhamento do sensor e 3D**. Ele reúne o mapeamento de eixos da
  montagem do sensor (altera os dados) e a exibição do modelo 3D (apenas visual)
  em uma prévia compartilhada. Conexão e zeragem ficam no cabeçalho e no Painel,
  dispensando um cartão de conexão separado.
- **Suporte PWA offline**: registra um service worker que armazena em cache
  recursos do aplicativo (HTML, estilos, scripts e modelo 3D GLB), permitindo
  uso offline em estandes remotos. Three.js 0.164.1, seu carregador de modelos e
  os controles de órbita são servidos localmente e incluídos no cache inicial.
  Painel, Loja de arcos e prévias de alinhamento não precisam de CDN. Abra o
  aplicativo online antes de ir ao estande para concluir a instalação do cache;
  sincronização opcional na nuvem ainda precisa de internet.
- **Guia no aplicativo**: consulte Início rápido, Recursos disponíveis,
  referência de comandos BLE e fluxo de tradução localmente. Os links
  permanecem no aplicativo, links de seção rolam até os títulos abaixo do
  cabeçalho e imagens são carregadas ao lado do Markdown de origem. Quando há
  uma página mapeada, o Guia carrega o Markdown no idioma selecionado. Páginas
  do Guia e a captura do Início rápido ficam no cache para leitura offline.
  Respostas atrasadas não substituem a seleção mais recente; falhas podem ser
  tentadas novamente ao reabrir o Guia.
- **Backup e restauração de dados locais**: um cartão em Configurações exporta
  todos os disparos, traçados, ajustes de sessão e perfis de arco locais em um
  arquivo JSON, e importa um arquivo unindo os registros por chave. Tudo é local,
  sem conta, facilitando transportar e guardar dados de testes de campo.
  - Backups completos e importações de um disparo são confirmados em uma
    transação; um registro posterior malformado reverte toda a importação.
    Versões de exportação incompatíveis e traçados divergentes em importações
    unitárias são rejeitados antes da gravação. O sucesso só é informado depois
    da confirmação no IndexedDB, inclusive antes das confirmações de disparo ao
    sensor.
  - Importações preservam envios pendentes deste navegador e criam novas tarefas
    de envio para registros restaurados na mesma transação. Ações antigas da
    fila não são reproduzidas e capturas de exemplo importadas permanecem
    locais. Controles de backup ficam desativados durante a preparação ou
    restauração. Importações com falha podem ser tentadas novamente com o mesmo
    arquivo; ações repetidas não duplicam restaurações ou tarefas de envio.
  - Uma importação confirmada continua bem-sucedida mesmo se a sincronização em
    nuvem ou a atualização de tela falhar. Avisos orientam reabrir Configurações
    ou Disparos salvos; os registros restaurados continuam salvos localmente.
    Resultados são anunciados por uma região de estado e o foco retorna ao
    botão que iniciou a ação.
  - Salvamentos tardios de traçado preservam resultados de flecha mais recentes
    e ignoram capturas excluídas. Metadados do dispositivo e tarefa de envio são
    confirmados antes da confirmação ao sensor; quadros duplicados compartilham
    a gravação e são confirmados novamente sem outra gravação.
  - Reenvios armazenados também solicitam uma reprodução ausente ou vazia para
    a captura original. Gravações completas são confirmadas sem novo download.
    Falhas de logs ou callbacks de atualização não impedem a confirmação nem
    invalidam metadados salvos. Atualizações ocupadas não atrasam a recuperação
    de traçados do firmware. Uma notificação de salvamento de conexão BLE antiga
    não pode confirmar uma conexão substituta. Falhas de sincronização mantêm
    envios na fila para nova tentativa.
  - Traçados do firmware são associados à captura exata da conexão atual;
    traçados atrasados do navegador mantêm seus buffers de amostras originais
    após reconectar. A recuperação do firmware preserva gravações não vazias do
    navegador, em qualquer ordem de chegada, e preenche gravações ausentes ou
    vazias. Falhas de progresso nos logs não deixam uma transferência travada.
    Um traçado confirmado continua salvo se logs, atualização de tela ou
    sincronização falharem. Revisões carregam o traçado salvo mais recente; uma
    conclusão antiga de transferência não substitui os dados da revisão atual.
    Ao atualizar um traçado inalterado, marcadores manuais, reprodução, edições
    de alvo inacabadas e foco são preservados.
  - Esses fluxos têm regressões cobertas no navegador com eventos de dispositivo
    simulados; testes de reconexão com sensor real ainda estão pendentes.
- **Exportação de um disparo**: use **Exportar disparo** na revisão ou o ícone
  ao lado de uma captura salva para baixar metadados e, opcionalmente, o traçado
  em JSON. O arquivo pode ser restaurado em Configurações. Metadados e traçado
  vêm da mesma versão salva, inclusive durante uma restauração concorrente.
  Capturas sem data usam `undated` no nome; traçados ausentes são informados sem
  bloquear a exportação. Progresso e erros aparecem na tela e edições inacabadas
  do alvo permanecem.
- **Exportação de disparos selecionados**: em Disparos salvos, escolha
  **Selecionar disparos**, marque as capturas e use **Exportar selecionados**.
  O JSON contém capturas, traçados e registros relacionados de sessão/arco, e
  pode ser restaurado em Configurações como um backup normal. Seleções
  sobrevivem às atualizações do histórico. Se uma captura estiver ausente, a
  exportação mostra um erro em vez de omiti-la silenciosamente.
  - Exportar a captura que atualmente inicia uma sessão preserva configurações
    herdadas e perfil de arco, mesmo se a captura antiga do contexto salvo não
    estiver selecionada. Atribuições diretas de arco também incluem os perfis
    correspondentes.
  - Exportações unitárias e selecionadas ignoram cliques repetidos enquanto
    preparam o arquivo e mantêm controles de exportação/exclusão desativados
    durante atualizações do histórico. O arquivo selecionado mantém as capturas
    marcadas no início da exportação, enquanto novas seleções e foco permanecem
    na tela. Falhas podem ser tentadas novamente. URLs de download ficam
    disponíveis por tempo suficiente para o navegador ler o arquivo.
- **Sincronização opcional com Supabase**: a janela Nuvem aceita URL Supabase e
  chave anon para sincronização auto-hospedada. Gravações locais no IndexedDB
  continuam sendo a fonte principal e são enfileiradas antes do envio; deixar
  as configurações da nuvem vazias mantém o aplicativo somente local.
  Carregamentos recuperam trabalho interrompido por recarga e incluem registros
  adicionados durante o envio. Chrome e Edge coordenam a fila entre abas com
  Web Locks; um envio com falha continua pendente até o próximo acionamento de
  sincronização.

## Idiomas, contador de disparos e OBS

- **Inglês americano e português brasileiro**: escolha **English (United
  States)** ou **Português (Brasil)** em **Configurações → Preferências**. O
  idioma fica salvo no perfil atual do navegador e é restaurado na próxima
  visita. Os JSON de idioma são `locales/en-US.json` e `locales/pt-BR.json`;
  a localização se aplica a rótulos estáticos, nomes acessíveis, mensagens
  dinâmicas, confirmações, overlays e páginas traduzidas do Guia. Consulte o
  [Guia de tradução](../translation-guide.md) para conhecer o formato JSON,
  correspondências exatas, padrões, mapeamento de páginas do Guia, cache offline
  e validação.
- **Ajuste do contador**: os botões **+**, **−** e **Zerar** corrigem a contagem
  exibida no Painel e salvam o ajuste neste navegador, sem permitir valor
  negativo. Eles não excluem disparos nem enviam o comando de firmware
  `shotreset`; o contador acumulado no dispositivo permanece separado. Restaurar
  as configurações de fábrica também preserva a contagem exibida.
- **Restauração das configurações de fábrica**: a ação em Configurações
  restaura idioma, overlay, tema, arco selecionado e preferências de sensor em
  cache. Disparos salvos, perfis de arco, contador localmente ajustado e
  credenciais de sincronização com a nuvem são mantidos. Os padrões do sensor
  são enviados quando ele se conectar novamente.
- **Quatro fontes de navegador independentes para OBS**: escolha uma URL gerada
  em **Configurações → Sobreposição do OBS Studio**:
  `?overlay=counter` (contador real e previsto), `?overlay=target` (traçado Pin
  Float mais recente), `?overlay=metrics` (último disparo) ou
  `?overlay=review` (resumo da sessão atual). Cada URL abre uma rota diferente
  para que cada fonte do OBS mostre somente a visualização escolhida. O overlay
  permite escolher fonte, tamanho de 14–40 px, cores do texto/fundo/destaque e
  quantidade prevista de 0–999 disparos. Para receber dados ao vivo, o Painel e
  a Fonte de Navegador do OBS precisam usar a mesma origem e o mesmo perfil do
  navegador.
