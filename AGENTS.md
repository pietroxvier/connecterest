# AGENTS.md

App desktop em Electron que mostra fotos do Pinterest filtradas por estética
(gótico, coquette, dark academia…). O usuário **não lê código**: ele julga pelo
que aparece na tela. Quebrar em silêncio é o pior resultado possível.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run check` | Sintaxe de todo JS + testes offline. **Rode antes de dizer que terminou.** |
| `npm test` | Só os testes offline (usam fixtures, sem rede) |
| `npm run smoke` | Sobe o Electron, busca um nicho real, salva e remove um favorito, e sai |
| `npm run test:live` | Teste que toca o Pinterest de verdade |
| `npm start` | Abre o app |
| `npm run fixtures` | Recaptura as fixtures do Pinterest |

Ferramentas de desenvolvimento (não fazem parte do produto):

| Comando | O que faz |
|---|---|
| `npx electron scripts/make-icon.js` | Gera `assets/icon.png` e `assets/icon.ico` |
| `powershell -File scripts/make-shortcut.ps1` | Recria o atalho do Desktop |
| `npx electron scripts/shot.js --hover=1 --out=shot.png` | Print do grid |
| `npx electron scripts/shot.js --view=favorites --out=fav.png` | Print dos favoritos |

Se `npm start` falhar com "Electron failed to install correctly", o binário não
foi baixado no `npm install`. Rode `node node_modules/electron/install.js`.

## Regras que não se negociam

1. **Paginação é `options.bookmarks`, um array.** `options.bookmark` (singular)
   é ignorado em silêncio e devolve a **mesma** página 1 com status `200`.
   Há um teste de regressão para isso. Não "simplifique" para singular.

2. **O renderer não pode chamar o Pinterest.** Não há header CORS. Toda rede
   acontece em `main/` e chega ao renderer por IPC (`window.lookbook`).

3. **Algumas queries voltam 0 fotos de propósito.** O Pinterest responde
   `200` com `data.results: []` e um objeto `sensitivity` (bloqueio regional).
   Exemplo real: `coquette aesthetic`. `searchWithFallback` tenta variações.
   Nunca trate "0 fotos" como bug sem conferir isso.

4. **Não cacheie resultado vazio por 6 h.** Vazio usa TTL de 10 min.
   Já implementado; não mexa sem motivo.

5. **Erro na tela, sempre.** Grid vazio e silencioso é indistinguível de bug
   para quem não lê código. Todo caminho de falha termina em
   `setStatus(ERROR_COPY[...], { error: true, actions })` — com destaque visual,
   não como texto cinza igual ao de carregamento.

6. **Texto de tela não fala em termo técnico.** Nunca escreva `keywords.json`,
   "query", "índice" ou caminho de arquivo na interface. Este usuário não
   programa. Termos técnicos só em `README.md` e neste arquivo.

7. **O renderer manda `id` de nicho, nunca uma query.** Isso impede o app de
   virar proxy aberto para o Pinterest.

## Arquitetura

```
main/lib.js        funções puras: monta URL, parseia resposta, valida config
main/pinterest.js  rede (node:https) + cache em disco + fila/throttle + download de imagem
main/favorites.js  índice JSON + arquivos na pasta do usuário (atômico, serializado)
main/lookbook.js   junta config + transporte; recebe `transport` injetável
main/paths.js      resolução de caminho com fallback (pictures -> documents -> home)
main/protocol.js   serve as imagens salvas em lookbook://fav/<arquivo>
main/ipc.js        ipcMain.handle -> { ok, ... } | { ok: false, error }
main/main.js       ciclo do app, janela, modo --smoke
preload/           contextBridge: window.lookbook.{niches,feed,favorites}
renderer/          HTML/CSS/JS puro, sem bundler, sem framework
keywords.json      a única coisa que se edita para mudar os filtros
assets/            icon.svg (fonte), icon.png, icon.ico
```

## Favoritos

- Gravados em `<Pictures>\Lookbook` (ou `Documents\Lookbook` se a pasta Imagens
  não existir na máquina) — arquivos de imagem + `favoritos.json`.
- Nome do arquivo = id do pin + extensão real (`.jpg`, `.png`…). Nunca force
  `.jpg`: alguns pins são PNG e seriam servidos com mime errado.
- Baixa a variante `736x` e cai para `originals` se o CDN responder 403
  (acontece com PNG). Ver `imageVariants()`.
- A tela nunca lê o disco direto: usa `lookbook://fav/<arquivo>`, servido por
  `main/protocol.js`. Se for adicionar outro caminho de imagem, use esse esquema.
- Remover um favorito **move o arquivo para `Lookbook/lixeira`**, não apaga.
  A tela oferece "Desfazer" por 8 s, que chama `favorites.restore`. Não troque
  isso por `unlink`: usuário sem familiaridade com arquivos não tem como
  recuperar nada depois.
- Índice corrompido é renomeado para `favoritos.json.quebrado-<timestamp>` em vez
  de ser sobrescrito. `list()` marca `missing: true` para arquivo que sumiu.

Sem bundler e sem framework no renderer de propósito: menos peças entre o
código e a tela.

## Onde mexer

- **Adicionar/ajustar filtro** → `keywords.json`. 2 ou 3 queries por nicho,
  sempre com pelo menos uma em inglês (tem mais acervo).
  Use `... outfit` / `... outfit ideas`, **não** `... aesthetic`: queries
  "aesthetic" trazem foto de mood (castelo, corvo, cenário) em vez de roupa.
  Isso já foi verificado na prática — não é preferência estética.
- **Mudar aparência** → `renderer/styles.css` (tokens no `:root`).
- **Mudar rede/cache** → `main/pinterest.js`. Rode `npm run check` depois.
- **Ícone** → edite `assets/icon.svg` e rode `npx electron scripts/make-icon.js`.

## Segurança

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
Não relaxe isso. `setWindowOpenHandler` manda links para o navegador externo.
CSP em `renderer/index.html` libera imagem só de `https://i.pinimg.com` e
`lookbook:`.

## Atalho do Desktop

`scripts/make-shortcut.ps1` cria `Lookbook.lnk` apontando para o `electron.exe`
do `node_modules`, com a pasta do projeto como argumento. Não há instalador nem
exe próprio. Se a pasta do projeto mudar de lugar, o atalho quebra: rode o
script de novo.

## Contexto do produto

Isso é uma API **interna** do Pinterest, não oficial. Quebra sem aviso e o uso
automatizado contraria os ToS. O código já é defensivo (throttle, cache,
fallback), mas não existe SLA: se o Pinterest mudar o formato, o primeiro
sintoma é `photos.length === 0` na tela.