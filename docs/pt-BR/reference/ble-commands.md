# Comandos de controle BLE

O firmware disponibiliza uma **característica de controle BLE**
(`8f3f3b10-0f5a-4f4c-9a2d-000000000003`) que aceita comandos ASCII. O aplicativo
web os envia pelo Painel e pelas Configurações, mas também é possível enviá-los
diretamente por uma ferramenta BLE, como `tools/openfloat_ble_client.py`, para
preparação e depuração.

---

## Controle da transmissão

- `start` — Ativa as notificações ao vivo (também envia um quadro de
  sincronização do contador).
- `stop` — Desativa as notificações ao vivo.
- `streamrate:<n>` — Define o divisor da transmissão BLE ao vivo: `1`, `2`, `5`,
  `10` ou `20` (aproximadamente 1110, 555, 222, 111 ou 55 Hz).

## Calibração

- `zero` — Captura os valores atuais de roll e pitch e os salva como offsets
  permanentes de nível na RRAM. O yaw continua sendo apenas visual no navegador
  e não é persistido pelo firmware.

## Detecção de disparos

- `thresh:<g>` — Limite de detecção da soltura, limitado ao intervalo de
  `2.0`–`30.0`.
- `shottrigger` — Gera um disparo sintético para testar em bancada a detecção, o
  envio de disparos salvos, o congelamento do traçado e o fluxo de confirmação.
- `shotreset` — Zera o contador de disparos acumulado persistido e limpa a fila
  de disparos salvos. Os IDs de captura continuam avançando; o próximo disparo
  terá um ID diferente dos registros anteriores.
- `shotset:<n>` — Corrige o contador acumulado persistido sem alterar o ID de
  captura. Use dígitos decimais entre `0` e `4294967295`.
- `shotack:<n>` — Confirma que o disparo de ID `n` foi salvo pelo navegador e
  libera sua posição de armazenamento. Use o ID de dispositivo de 32 bits do
  quadro de disparo salvo.
- `shotdump` — Solicita o envio de disparos salvos pendentes e de um quadro com
  o estado do armazenamento.

Os botões `+`, `−` e **Zerar** do Painel ajustam somente a contagem exibida pelo
navegador; não enviam `shotset` nem `shotreset` e não excluem disparos salvos.
Use os comandos BLE acima apenas quando quiser alterar intencionalmente o
contador acumulado persistido ou a fila do firmware.

Os valores de disparo (`shotset`, `shotack` e os três comandos de solicitação de
traçado) devem conter dígitos decimais sem sinal. Valores vazios, sinais,
espaços, sufixos e números acima de `4294967295` são rejeitados sem alterar o
contador nem iniciar uma transferência. Bytes NUL embutidos são rejeitados em
todos os comandos de controle. Correções e reinicializações válidas preservam os
IDs de captura após reinicializações. O contador acumulado para de aumentar no
valor máximo; o ID de captura independente continua seu ciclo normal. Use o ID
de dispositivo nos metadados do evento para confirmações e solicitações de
traçado; ele pode ser diferente do contador acumulado exibido.

## Gerenciamento de energia

- `wakesens:<g>` — Limite do acelerômetro para despertar, limitado a
  `0.5`–`8.0` g.
- `sleeptime:<s>` — Tempo limite do repouso profundo em segundos, limitado a
  `5`–`600`. O padrão do firmware novo é 300 s.
- `sleepsens:<g>` — Limite de movimento em repouso para manter o sensor ativo:
  `0.05`–`0.50` g.
- `autosleep:<0|1>` — Ativa ou desativa o repouso profundo por inatividade.

Antes do repouso automático, o firmware conclui o pós-disparo e salva as
configurações pendentes, os disparos na fila e os traçados solicitados. Durante
essa breve gravação final, se houver solicitação de resposta, o callback de
controle rejeita novos comandos com ATT Write Request Rejected (`0xfc`). Em caso
de falha, são feitas até três tentativas; erros persistentes mantêm o sensor
ligado e adiam o repouso por trinta segundos. Os controles voltam a funcionar
quando o repouso é adiado. O comportamento físico do repouso/despertar e o tempo
dos callbacks ainda precisam ser verificados no hardware.

## Buffer de traçado

- `tracetimed:<shot_id>` — Solicita o traçado salvo completo, com tempos
  registrados, referência da soltura e validação de checksum. Suporta todos os
  1000 pontos.
- `tracereq2:<shot_id>` — Solicita um traçado de compatibilidade sem tempos, com
  IDs de disparo de 32 bits e índices de bloco de 16 bits. Suporta os 1000
  pontos armazenados.
- `tracereq:<shot_id>` — Formato de transferência antigo, limitado aos 692
  pontos atuais. O firmware atualizado retorna status 2 para traçados maiores.
  O navegador tenta primeiro o comando com tempos e, depois, os formatos
  estendido e legado. Todos os comandos retornam status de traçado 0 quando a
  posição solicitada não está disponível.
- `bufrate:<hz>` — Taxa do buffer do traçado: `0`, `52`, `104` ou `208` Hz.
- `bufnvs:<0|1>` — Ativa ou desativa a persistência dos traçados na RRAM.
- `followms:<ms>` — Atraso após a soltura antes de congelar o traçado, limitado a
  `0`–`3000` ms.

Os comandos de ajuste exigem valores completos. Alternâncias e taxas aceitam
somente dígitos decimais sem sinal e devem corresponder às opções listadas.
`sleeptime` e `followms` aceitam inteiros decimais com sinal de 32 bits; números
válidos fora dos limites são ajustados para o limite correspondente. `thresh`,
`wakesens` e `sleepsens` aceitam números decimais finitos, inclusive em notação
exponencial, e respeitam seus limites. Valores vazios, espaços, sufixos, notação
hexadecimal, NaN, infinito e estouro de conversão são rejeitados com ATT "Value
Not Allowed" (`0x13`), sem alterar as configurações do dispositivo.

Na inicialização, os valores de ajuste persistidos precisam ter um registro
completo de quatro bytes e estar dentro dos limites aceitos. Valores inválidos
mantêm os padrões do firmware, incluindo um divisor de transmissão válido e
diferente de zero.

---

> As configurações enviadas pelo aplicativo são armazenadas em cache local e
> persistidas no dispositivo quando o firmware oferece suporte ao comando. Se um
> dispositivo antigo ainda tiver um tempo de repouso persistido muito curto,
> envie `sleeptime:300` uma vez para atualizá-lo.
