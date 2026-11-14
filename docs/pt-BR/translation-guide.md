# Como traduzir o OpenFloat

Este guia explica como adicionar ou melhorar um idioma no aplicativo web
OpenFloat. A interface usa arquivos JSON por idioma; não é necessário instalar
uma biblioteca de tradução nem adicionar uma etapa de compilação.

## O que é traduzido e onde

- `locales/en-US.json` é o idioma-fonte em inglês americano e o padrão do app.
- `locales/pt-BR.json` contém o português brasileiro.
- `app/ui/localization.js` carrega o JSON selecionado, aplica as traduções,
  guarda a escolha em `localStorage` do navegador e traduz textos inseridos ou
  alterados enquanto o app está aberto.
- `index.html` contém o seletor de idioma em **Configurações → Preferências**.
- `docs/` contém as páginas Markdown exibidas no Guia dentro do aplicativo.

Os arquivos de idioma do app são JSON UTF-8 comum. Todos devem ter as mesmas
chaves de nível superior. A maioria das mensagens principais são rótulos e
textos usados pelos atributos `data-i18n` e pelos overlays do OBS. `_text`
guarda frases exatas da interface; `_patterns` guarda traduções com expressões
regulares para mensagens que incluem valores variáveis.

## Traduzir uma frase existente

1. Encontre a frase em inglês no `index.html` ou no módulo correspondente
   dentro de `app/`. Procure o rótulo, estado, nome acessível ou confirmação que
   aparece para a pessoa — não um log do console ou identificador interno.
2. Para um rótulo estático com `data-i18n`, adicione a mesma chave de nível
   superior aos dois arquivos. Para uma frase dinâmica exata, use a própria
   frase em inglês como chave no objeto `_text` do locale traduzido;
   `en-US.json` não precisa traduzir a si mesmo.
3. Mantenha a chave idêntica ao texto-fonte em inglês, incluindo pontuação,
   maiúsculas, espaços e qualquer símbolo que faça parte do mesmo nó de texto.
   Por exemplo, o ícone `⚠` deve estar na chave se aparecer no mesmo parágrafo
   que a frase. Entidades HTML como `&mdash;` são decodificadas pelo navegador;
   use o caractere resultante (`—`) na chave JSON.
4. Preserve nomes de produtos, unidades técnicas, nomes de comandos e valores
   que não devem ser traduzidos. Prefira traduções concisas para caber em
   botões, painéis estreitos e overlays.

Correspondências exatas diferenciam maiúsculas de minúsculas. Se a marcação HTML
dividir uma frase em vários nós de texto, traduza cada parte visível ou altere a
marcação de forma intencional e teste. Não use texto em inglês como chave de
tradução como atalho.

### Rótulos estáticos e textos acessíveis

Para HTML estático, prefira o padrão existente de `data-i18n`:

```html
<button data-i18n="resetCounter">Reset</button>
```

Adicione a mesma chave de nível superior aos dois arquivos de idioma:

No arquivo `locales/en-US.json`:

```json
{ "resetCounter": "Reset" }
```

No arquivo `locales/pt-BR.json`:

```json
{ "resetCounter": "Zerar" }
```

Para textos acessíveis, use os atributos correspondentes já existentes:
`data-i18n-title` e `data-i18n-aria-label`. O observador de localização também
traduz os valores de `title`, `aria-label` e `placeholder` quando são criados ou
alterados dinamicamente.

Para mensagens dinâmicas gravadas com `.textContent`, o observador pode traduzir
a frase exata depois que ela aparece. Para `alert()`, `confirm()` ou mensagens
que precisam ser traduzidas antes da exibição, importe e chame
`translateMessage()` de `app/ui/localization.js`. Prefira incluir traduções no
JSON em vez de criar condicionais por idioma no código do aplicativo.

## Traduzir mensagens com valores variáveis

Use `_patterns` quando a mensagem incluir números ou outros textos variáveis.
Os padrões são expressões regulares JavaScript aplicadas à frase completa.
Use `$1`, `$2` e assim por diante para inserir os grupos capturados. Use `$t1`,
`$t2` e assim por diante se o trecho capturado também for uma frase conhecida
que deva ser traduzida.

Por exemplo, para uma mensagem como `Step 2 of 5`, mantenha o padrão que
corresponde ao texto-fonte em inglês e traduza o texto de substituição:

```json
{
  "_patterns": [
    { "pattern": "^Step (\\d+) of (\\d+)$", "replacement": "Etapa $1 de $2" }
  ]
}
```

Escape a pontuação especial de expressões regulares (`.`, `?`, `(`, `)` e
semelhantes) quando ela precisar corresponder literalmente. Use `^` e `$` para
corresponder à frase inteira, evitando traduzir texto não relacionado. Coloque
padrões mais específicos antes dos mais genéricos. Não adicione um padrão que
apenas repita uma entrada exata já existente em `_text`.

Teste cada padrão com pelo menos dois valores diferentes. Confira pontuação,
espaços, unidades e os ícones que possam aparecer junto do estado ou aviso.

## Traduzir páginas do Guia

As páginas do Guia são arquivos Markdown listados por IDs estáveis em
`docs/index.json`. Mantenha a página em inglês dentro de `docs/`; coloque a
tradução em `docs/pt-BR/`, preservando o mesmo caminho relativo e nome de
arquivo.

Depois, mapeie o ID estável da página em `_guidePages` do locale traduzido:

```json
{
  "_guidePages": {
    "quick-start": "docs/pt-BR/quick-start.md"
  }
}
```

O locale inglês usa os caminhos padrão de `docs/index.json`. O Guia usa o ID
para criar seu link interno; mantenha-o estável ao traduzir. Use links e
caminhos de imagens relativos ao arquivo Markdown traduzido. O renderizador
suporta intencionalmente apenas um subconjunto seguro de Markdown; HTML bruto é
exibido como texto.

Execute `python tools/build_docs_index.py` ao adicionar, renomear ou remover uma
página-fonte em inglês do Guia. Confira se o `docs/index.json` gerado contém o
ID e o caminho esperados. Páginas traduzidas não aparecem separadamente no
índice; adicione os novos arquivos Markdown traduzidos à lista de pré-cache
`ASSETS` de `service-worker.js` para disponibilizá-los offline e incremente
`CACHE_NAME` para que instalações existentes recebam a documentação atualizada.

## Adicionar um novo idioma ao aplicativo

Adicionar um idioma exige mais do que copiar um JSON:

1. Crie `locales/<código-de-idioma>.json` usando
   `locales/en-US.json` como referência para as chaves de nível superior e
   `locales/pt-BR.json` como referência para o inventário de traduções
   `_text`/`_patterns`. `en-US.json` é o idioma padrão e atualmente não precisa
   mapear suas frases-fonte para si mesmo. Na nova língua, mantenha as chaves
   inglesas de `_text` e os padrões que correspondem às frases-fonte; traduza
   seus valores e substituições.
2. Inclua o código BCP 47 em `SUPPORTED_LOCALES`, em
   `app/ui/localization.js`. Decida conscientemente se o idioma padrão deve
   mudar; atualmente o fallback é o inglês.
3. Adicione uma opção legível para a pessoa em `#languageSelect`, no
   `index.html`.
4. Traduza as páginas Markdown do Guia em `docs/<código-de-idioma>/` e mapeie
   seus IDs estáveis em `_guidePages`. O gerador do índice omite pastas de
   idiomas da navegação; o locale selecionado aponta os mesmos IDs para os
   arquivos traduzidos.
5. Inclua o JSON do idioma e suas páginas traduzidas no pré-cache do service
   worker; depois, incremente a versão do cache.
6. Adicione testes para a estrutura equivalente dos locales, caminhos do Guia,
   persistência/fallback e mensagens representativas exatas e com padrões.
7. Confira o Guia, Painel, Configurações, Mira Estável, Disparos salvos,
   confirmações, rótulos acessíveis e as quatro rotas de overlay do OBS no novo
   idioma. Textos longos devem continuar claros e não podem ser cortados nem
   sobrepor elementos próximos.

## Validar as alterações

Execute os testes de idioma e, em seguida, a suíte completa:

```sh
node --test test/locales.test.js
npm test
```

Confira também se o JSON é válido, se não há chaves ou padrões duplicados e se
o diff não contém erros de espaço em branco:

```sh
git diff --check
```

Os testes de locale verificam a estrutura equivalente entre inglês e português,
a existência das páginas configuradas no Guia, a persistência do idioma e o
resultado de traduções exatas e dinâmicas representativas. Ao alterar o service
worker ou o índice do Guia, execute a suíte completa, que também testa o uso
offline da documentação.

## Checklist de tradução

- [ ] Manter todas as chaves de nível superior sincronizadas com `en-US.json`.
- [ ] Preservar exatamente as chaves-fonte, capturas regex e pontuação.
- [ ] Traduzir textos visíveis e acessíveis, inclusive mensagens dinâmicas.
- [ ] Incluir ícones nas chaves exatas quando estiverem no mesmo nó de texto.
- [ ] Traduzir as páginas correspondentes do Guia e conferir links relativos.
- [ ] Manter consistentes o índice do Guia, o mapa do locale e o pré-cache offline.
- [ ] Conferir telas estreitas e testar cada rota de overlay do OBS.
- [ ] Rodar os testes de locale, a suíte completa e `git diff --check`.
