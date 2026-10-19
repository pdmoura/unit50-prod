# Unit 50 · Fieldwork

Aplicativo de prospecção residencial em Weber County, Utah, com banco PostgreSQL e fotos dos imóveis no Cloudinary. Interface em inglês, com mapa de dados reais, prioridade por idade cadastral, histórico de visitas e agenda de retornos.

## Executar no Windows

Requisitos: **Node.js 24.15 ou superior da série 24**, com npm, e um banco **PostgreSQL**: o local do `docker-compose.yml` (Docker Desktop) ou um hospedado, como o Supabase.

Na pasta do projeto:

```powershell
Copy-Item .env.example .env   # ajuste DATABASE_URL, DATABASE_URL_DEV e as variáveis CLOUDINARY_*
npm run db:up                 # só para o banco local em Docker (porta 15432)
npm ci
npm run build
npm start
```

Dois bancos, escolhidos pela forma de iniciar:

| Comando             | Banco usado                                           |
| ------------------- | ----------------------------------------------------- |
| `npm start`         | `DATABASE_URL` (produção, por exemplo o Supabase)     |
| `npm run dev`       | `DATABASE_URL_DEV` (Postgres local em Docker)         |
| `npm run start:dev` | `DATABASE_URL_DEV`, com a versão compilada            |
| `npm test`          | banco `<nome>_test` no servidor de `DATABASE_URL_DEV` |

Para o Supabase, use a string **Session pooler** do botão **Connect**. Bancos fora da própria máquina são acessados com TLS; acrescente `?sslmode=disable` à URL se o servidor não oferecer TLS. O servidor registra no log, ao iniciar, o host e o nome do banco em uso. As tabelas são criadas ou atualizadas automaticamente ao iniciar.

Abra **http://127.0.0.1:3000**. Para encerrar, pressione `Ctrl+C` no terminal do servidor. Execute apenas uma instância por banco de dados. Não inicie `dev` enquanto `start` estiver rodando.

O servidor aceita conexões apenas da própria máquina. Esta versão é individual, sem login e sem publicação na internet. Não altere o host para expor o aplicativo à rede sem implementar autenticação.

### Desenvolvimento

```powershell
npm run dev
```

Abra http://127.0.0.1:5173. O Vite encaminha `/api` ao Fastify na porta 3000. A versão de produção serve frontend e API na mesma porta 3000.

## Primeiro uso

1. Abra **Data & imports** e clique em **Import county data**. A importação é explícita e não é executada automaticamente ao iniciar o programa.
2. Aguarde a conclusão. O progresso mostra os registros recebidos; a base anterior continua ativa durante a atualização.
3. Em **Prospecting map**, pesquise endereço ou parcela, ou filtre cidade, prioridade, status e intervalo de idade.
4. Clique em um imóvel para consultar a ficha. **Log visit** registra o resultado e as observações, com horário atual em UTC exibido no fuso de Utah.
5. Use **Follow up** para agendar uma data. Na tela **Follow-ups**, conclua ou reagende o retorno.

Os dados comerciais são salvos no PostgreSQL e permanecem após fechar a aba ou reiniciar a aplicação. Não dependem de `localStorage`.

O mapa mostra pontos e agrupamentos dentro da área visível. Por padrão, a lista pesquisa todo o condado. Ative **Search this map area** para limitar também a lista à janela do mapa. Clique em um grupo para aproximar. A pesquisa usa o endereço cadastral ou o identificador original, sem geocodificação externa.

### Contato e agenda

Status: `Not visited`, `No answer`, `Interested`, `Not interested`, `Do not contact`.

Uma visita atualiza o status e registra uma atividade na mesma transação. **Do not contact** cancela todos os retornos pendentes e impede novos agendamentos, reabertura de tarefas e novas visitas. O histórico permanece disponível; a mudança de status é explícita. A conclusão e o cancelamento de uma tarefa não apagam a atividade.

Datas de retorno não têm horário ou conversão de fuso. Hoje/atrasado usam `America/Denver`, inclusive horário de verão. Tarefas de parcelas que desapareçam do cadastro permanecem visíveis para consulta e conclusão, mas não podem ser reabertas ou receber novos retornos enquanto a parcela estiver inativa.

## Dados e prioridade

Fonte: [Weber County — Parcel Master](https://maps.webercountyutah.gov/arcgis/rest/services/gis/parcels_geogizmo2/MapServer/0). Filtro da versão inicial: `PROP_DESC = 'SINGLE FAM RES'`. Condomínios, PUDs, duplexes e outras categorias não entram nesta versão.

Campos importados: `OBJECTID`, `PARCEL_ID`, `PROP_STREET`, `PROP_CITY`, `PROP_ZIP`, `PROP_DESC`, `WGT_AVE_RI_YB`, `TTL_RI_SQFT` e geometria.

Proprietário e impostos (mesma camada, a cada importação): `NAME_ONE` (proprietário), `STREET`/`CITY_STATE`/`ZIPCODE` (endereço de correspondência), `TaxYear`, `TAX_UNIT` (tax area), `TOT_MARKET`, `TOT_TAXABLE`, `YR_RATE`, `NET_ASMT_CHAR`, `TOT_DIRECT`, `PENALTY_CHAR`, `TOT_PAYMENTS`, `TotalCharge`, `landgrossacrecount` (acres), `LEA` (neighborhood), `SUBDIVISIO`, `WGT_AVE_RI_QLTY`, `WGT_AVE_RI_CDTN`, `ACCOUNT_TYPE`. Ficam em colunas de `properties`, aparecem na aba **County** da ficha e o proprietário entra na busca. Esses valores não participam da detecção de conflito entre geometrias.

### Weber County Parcel Search

Dados que a camada GIS não tem vêm de [Parcel Search](https://webercountyutah.gov/parcelsearch/) (`current-taxes.php` e `property-characteristics.php`): empresa de financiamento (loan company), cobranças diretas e pagamentos item a item, saldo, greenbelt, tipo de terreno e cada edificação (tipo, estilo, exterior, telhado, qualidade, ano, área, porão e % de acabamento), além de links do croqui e do plat map. São páginas HTML, lidas por `server/parcelsearch.ts` e gravadas como JSON em `county_details`.

- Por parcela: botão **Fetch/Refresh from Parcel Search** na aba **County**.
- Todas as parcelas: card **Parcel Search details** em **Data & imports**. Roda em segundo plano no servidor, 3 parcelas em paralelo, cerca de 1 parcela/s; ~66 mil parcelas levam de 15 a 18 horas. **Stop** interrompe; iniciar de novo continua só com o que falta ou falhou. **Refresh** relê o que tiver mais de 30 dias.
- Uma releitura que falhe mantém os últimos dados bons e registra o erro. Parcelas inexistentes são marcadas como erro.

- Os IDs são enumerados antes da carga, e os registros são obtidos em lotes de até 500, em WGS84. Cada lote deve corresponder exatamente aos IDs solicitados.
- Cada consulta tem timeout de 45 segundos e até três tentativas. Registros são validados em tabelas temporárias de carga. Erros ou interrupções mantêm a base anterior.
- A ativação é uma única transação. Visitas, status e retornos ficam em tabelas distintas dos atributos importados.
- `PARCEL_ID` é texto: zeros à esquerda são preservados. Múltiplas geometrias da mesma parcela são mantidas individualmente e consolidadas em uma ficha.
- Se os atributos dessas geometrias divergirem, a ficha informa o conflito, mantém os valores do menor `OBJECTID` como referência e recebe prioridade **Unknown**. Isso não resolve a divergência cadastral.
- Geometria inválida deixa a parcela disponível na lista, sem ponto no mapa. Um ponto representativo do polígono não corresponde necessariamente à entrada da residência.
- Parcelas ausentes numa atualização ficam inativas, sem exclusão do histórico comercial. A nova base passa a representar somente as geometrias da carga atual.
- A tela **Data & imports** exibe a quantidade de parcelas com observações e até 100 registros para revisão. A ficha sempre mostra todas as observações daquele imóvel.

### Regra inicial

Usamos o ano de Utah e a parte inteira de `ano atual - WGT_AVE_RI_YB`.

| Idade estimada                                                | Prioridade |
| ------------------------------------------------------------- | ---------- |
| 40 anos ou mais                                               | High       |
| 20–39 anos                                                    | Medium     |
| Menos de 20 anos                                              | Low        |
| Ano ausente, menor que 1600, futuro ou atributos conflitantes | Unknown    |

O valor cadastral original é preservado, inclusive frações. Ele pode ser uma média ponderada, não uma data exata de construção. Os limites estão definidos em `shared/types.ts`; a expressão SQL correspondente está em `server/db.ts`.

**A prioridade é uma hipótese para organizar prospecção, não probabilidade de compra nem prova de necessidade de reforma.** Área residencial não é medida de fachada.

O mapa-base utiliza [OpenStreetMap](https://www.openstreetmap.org/copyright), com atribuição visível e [política de uso de tiles](https://operations.osmfoundation.org/policies/tiles/) respeitada: sem pré-carregamento ou download em massa. A internet é necessária para importação, mapa-base e fontes tipográficas externas. Sem rede, registros já importados e atividades continuam disponíveis na lista; fontes têm fallback local.

## Login (Supabase Auth)

Com `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` definidos, o aplicativo exige login por email e senha. O navegador entra pelo Supabase Auth e envia o token em cada chamada da API; o servidor confere o token com o Supabase e só aceita emails confirmados que estejam na tabela `app_users`. Não há cadastro pelo aplicativo, e o cadastro público está desativado no projeto Supabase (`supabase/config.toml`, `enable_signup = false`).

Para liberar uma pessoa:

1. No painel do Supabase: **Authentication → Users → Add user → Create new user**, com email, senha e **Auto Confirm User** marcado.
2. Em **Team & access** (só para admins), adicione o email e escolha o papel. Ou, na pasta do projeto: `npx tsx scripts/allow-user.ts pessoa@empresa.com` (acrescente `--admin` para admin, `--dev` para o banco local, `--remove` para retirar o acesso, `--list` para ver quem está liberado).

### Papéis e módulos

- **Super admin** (o dono do aplicativo): tudo o que o admin faz, mais a página **Data & imports**, a importação do condado, a leitura em lote do Parcel Search e o botão de atualizar o Parcel Search na ficha. Admins e reps não veem nem acessam nada disso; o servidor recusa as chamadas. Só é dado ou retirado no servidor, nunca pelo aplicativo: `npx tsx scripts/allow-user.ts voce@empresa.com --super-admin` (ou `--no-super-admin`). O painel **Team & access** mostra quem é, mas não deixa mudar o papel nem remover essa pessoa. Sem login (modo local), quem usa o computador é o super admin.
- **Admin**: usa todos os módulos e o painel **Team & access**, onde adiciona e remove pessoas, muda o papel e liga ou desliga, por pessoa, cada módulo: **Prospecting map**, **Follow-ups** e **Leads**. Um admin não pode remover a si mesmo nem mudar o próprio papel, e o time sempre fica com pelo menos um admin.
- **Rep**: começa com todos os módulos ligados. O servidor confere o acesso em cada chamada, então uma mudança vale no clique seguinte da pessoa. A ficha do imóvel abre a partir do mapa, dos follow-ups e dos leads, então fica disponível com qualquer um desses três módulos.
- Cada visita e cada follow-up guardam o email de quem registrou (`created_by`). O rep vê e altera só os próprios follow-ups (na página Follow-ups, na ficha e nos contadores); o histórico de visitas do imóvel é do time inteiro e mostra quem bateu. O admin vê os follow-ups de todos, com **Everyone / Mine**. Registros anteriores ao login não têm autor e aparecem só para admins.
- Sem login (modo local), a pessoa no computador é tratada como admin.

## Leads do site (unit50-studio)

O site envia cada lead novo e cada pedido de acompanhamento como um POST assinado para `/api/webhooks/website` (cabeçalhos `X-Unit50-Timestamp` e `X-Unit50-Signature`, HMAC-SHA256 de `<timestamp>.<corpo>` com o segredo compartilhado). O servidor recusa assinaturas erradas e envios com mais de 5 minutos de diferença no relógio, e grava o lead em `leads`. Entregas repetidas ou fora de ordem só completam o lead, nunca apagam dados. Envios de candidaturas (careers) são aceitos e ignorados.

- Configure `LEADS_WEBHOOK_SECRET` aqui e o mesmo valor como `WEBHOOK_SECRET` no site, com `WEBHOOK_URL=https://unit50.onrender.com/api/webhooks/website`. Sem o segredo, o endpoint responde 503 e o site guarda os leads na fila dele até a configuração existir.
- O endereço do lead é ligado à parcela do condado quando não há dúvida: mesmo número e rua perto do ponto do mapa, ou a única parcela a até 25 m do ponto. Sem isso, o lead fica sem parcela.
- Só links de imagem do Cloudinary (`res.cloudinary.com`) são guardados; qualquer outro é descartado.
- **Quadro de leads**: colunas **Unassigned** (fila do time), **New**, **Contacted**, **Appointment set**, **Estimate sent**, **Won** e **Lost**. O rep vê a fila e os próprios leads; mover um lead da fila (arrastando no computador ou pelo campo Stage na ficha) faz dele o responsável, e ele pode devolver o lead à fila. Dois reps nunca ficam com o mesmo lead. O admin vê todos, filtra por pessoa e atribui a qualquer um do time. Remover uma pessoa devolve os leads dela para a fila.
- No celular e no tablet, o quadro mostra uma coluna por vez; os botões de etapa acima dele mostram a coluna atual e levam a qualquer outra. Enquanto não houver lead, um cartão explica como o lead chega e tem o link para o estúdio do site.
- A ficha do lead mostra telefone (ligar ou mandar mensagem), se a pessoa pediu acompanhamento, se marcou "OK to contact me" no site, o interesse (siding, windows), a foto e o desenho do estúdio, e o link para a parcela no mapa.

Sem essas duas variáveis o aplicativo roda sem login e aceita conexões apenas da própria máquina; o servidor se recusa a iniciar num endereço público nessa condição.

## Publicação (Railway)

O aplicativo roda no Railway, projeto `unit50`, serviço `fieldwork`, região US West (Califórnia, ao lado do banco no Supabase em Oregon), com deploy a cada push na branch `main`. As configurações ficam no próprio serviço (painel do Railway), sem arquivo no repositório: build `npm run build`, início `npm start`, verificação de saúde em `/api/health`, reinício em caso de falha. No Railway o servidor escuta em todas as interfaces sozinho (`RAILWAY_ENVIRONMENT`); em outro servidor, defina `HOST=0.0.0.0`.

Variáveis no serviço: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CLOUDINARY_*`, `LEADS_WEBHOOK_SECRET`, `WEBSITE_URL` e `PORT=8080`. A importação do condado e a leitura em lote do Parcel Search são pesadas e raras; rode-as do seu computador com `npm start` (mesmo banco), como super admin.

## Fotos do imóvel (Cloudinary)

Na ficha do imóvel, **Add photo** abre a câmera ou a galeria. O arquivo vai direto do navegador para o Cloudinary, com uma assinatura de uso único emitida pelo servidor; o segredo da API nunca chega ao navegador. O Cloudinary devolve um comprovante assinado, que o servidor confere antes de gravar a foto em `property_photos`. Remover a foto apaga primeiro a imagem no Cloudinary e depois o registro.

- Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` e, se quiser, `CLOUDINARY_FOLDER` (padrão `unit50-uploads`). Sem essas variáveis, o botão de fotos não aparece.
- Use uma chave restrita à pasta. `scripts/cloudinary-folder-access.mjs` concede o papel Manager nessa pasta (ver comentários no arquivo).
- Limites: 30 fotos por imóvel, 15 MB por arquivo, formatos JPG, PNG, WebP e HEIC.

## Street View: posição da câmera e cobertura

O botão **Street View** da ficha abre o Google Maps na rua em frente ao imóvel, já virado para ele. Dois scripts de linha de comando preparam isso; nenhum deles roda sozinho.

**1. Posição e direção** (`scripts/street-view.ts`): calcula, a partir das ruas do OpenStreetMap, um ponto na rua em frente a cada imóvel e a direção para olhar. Rode de novo depois de uma importação do condado, para cobrir parcelas novas.

```powershell
npx tsx scripts/street-view.ts          # produção (DATABASE_URL)
npx tsx scripts/street-view.ts --dev    # banco local (DATABASE_URL_DEV)
```

**2. Cobertura** (`scripts/street-view-check.ts`): pergunta ao Google, imóvel por imóvel, se existe imagem de Street View naquele ponto, e grava a resposta em `properties.street_view_status` (`available` ou `none`) e o ID do panorama em `street_view_pano`.

- Usa a consulta de _metadata_ da Street View Static API, que é gratuita. **Nenhuma imagem é baixada nem guardada**: os termos do Google Maps Platform proíbem armazenar ou re-hospedar imagens do Street View (por exemplo, no Cloudinary) e baixá-las em massa. O ID do panorama pode ser guardado.
- Precisa de `GOOGLE_MAPS_API_KEY` no `.env`: no Google Cloud, crie um projeto com faturamento ativo, habilite a **Street View Static API** e crie uma chave restrita a essa API. `GOOGLE_MAPS_SIGNING_SECRET` (segredo de assinatura de URL) é opcional. Nunca use o prefixo `VITE_` nessas variáveis.

```powershell
npx tsx scripts/street-view-check.ts --id 190880007 --dev   # um imóvel
npx tsx scripts/street-view-check.ts --limit 20 --dev       # piloto com 20
npx tsx scripts/street-view-check.ts --limit 20             # piloto em produção
npx tsx scripts/street-view-check.ts --all                  # todos os que faltam
```

- Para **retomar** depois de uma interrupção, rode o mesmo comando outra vez: imóveis que já têm resposta são pulados.
- Opções: `--concurrency 4` (1 a 16 consultas ao mesmo tempo), `--dry-run` (consulta e relata, sem gravar no banco), `--retry-uncertain` (olha de novo os casos incertos).
- Resultados possíveis por imóvel:
  - `available`: há imagem a até 25 m do ponto esperado na rua. Gravado no banco.
  - `none`: o Google confirmou que não há imagem perto do ponto na rua nem a até 150 m da parcela. Gravado no banco.
  - `uncertain`: há imagem por perto, mas não em frente (ou o imóvel não tem ponto na rua). Não é gravado; vai para revisão.
  - `failed`: a consulta não funcionou (tempo esgotado, erro do servidor, limite de uso). Não é gravado e nunca vira `none`; a próxima execução tenta de novo.
- Chave recusada pelo Google ou 25 falhas seguidas interrompem a execução, em vez de marcar o condado inteiro como falha.
- Progresso e problemas ficam na pasta local `street-view-report/` (fora do Git): `checkpoint-<banco>.jsonl` (uma linha por imóvel consultado), `report-<banco>.json` (totais da última execução) e `review-<banco>.csv` (incertos e falhas, com endereço).

## Configurações do site (Settings)

Só para admins. A página **Settings** abre ou fecha a página de vagas do site (`/careers`) e edita o texto dela: cargo, título, introdução, as duas listas e a observação. As mudanças aparecem no site em até cerca de 10 segundos, sem novo deploy.

- O site guarda essas configurações no banco dele (tabela `site_settings`), então nunca depende deste aplicativo para abrir uma página. Este aplicativo lê e grava pelo endpoint `/api/admin/careers` do site, com a mesma chave compartilhada dos leads (`LEADS_WEBHOOK_SECRET` aqui, `WEBHOOK_SECRET` no site). A assinatura inclui método e caminho, então um envio de lead nunca vale como mudança de configuração.
- O endereço do site vem de `WEBSITE_URL` (padrão `https://unit50-studio.onrender.com`). Se o site estiver dormindo, a primeira leitura pode levar até um minuto.
- Fechada, a página `/careers` e o formulário respondem 404 e os links somem do menu, do rodapé, da página 404 e do sitemap.

## Banco, backup e recuperação

Banco PostgreSQL definido em `DATABASE_URL` (produção) ou `DATABASE_URL_DEV` (desenvolvimento, com `--dev`). As migrações ficam em `server/migrations.ts`, são registradas na tabela `schema_migrations` e aplicadas ao iniciar o servidor. Não apague o banco para atualizar os dados.

Banco local (Docker): `npm run db:up` cria o Postgres em `127.0.0.1:15432` com volume persistente. Para uma cópia de segurança:

```powershell
docker compose exec -T db pg_dump -U unit50 -d unit50 -Fc -f /tmp/unit50.dump
docker compose cp db:/tmp/unit50.dump ./unit50.dump
```

No Supabase, os backups são feitos pelo próprio serviço, conforme o plano.

`PORT` altera a porta HTTP; a interface padrão foi preparada para 3000 e o desenvolvimento para 5173.

## Testes

```powershell
npm test
npm run build
npm run test:e2e
```

- Os testes precisam do Postgres local (`npm run db:up`) com o banco `unit50_test`, ou de `TEST_DATABASE_URL`. Cada teste cria e apaga um schema próprio; **nenhum teste usa as tabelas do aplicativo, e `DATABASE_URL` (produção) nunca é lido pelos testes**.
- Testes unitários e de integração: prioridades e frações, datas, IDs, geometrias, conflitos, carga incompleta, parcelas inativas, bloqueio de contato, validação de API, filtros, persistência após reinício do servidor, páginas do Parcel Search, fotos (assinatura, conferência do comprovante e remoção) com um Cloudinary simulado, e a verificação de cobertura do Street View com um Google simulado.
- Testes de navegador: usam Microsoft Edge instalado e um servidor temporário em `127.0.0.1:3100` com parcelas artificiais.
- O fluxo automatizado cobre imóvel → visita → retorno → recarregamento → conclusão → bloqueio de contato. Também verifica filtros e largura de 390 px.
- Capturas de tela e traces de falhas são gravados em `test-results/`.

## API local

Os erros retornam JSON `{ "error": "mensagem" }`. Entradas inválidas retornam 400; recursos inexistentes, 404; ações bloqueadas por estado, 409. IDs de parcela precisam ser codificados na URL.

| Método e rota                                | Uso                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                            | Disponibilidade                                                                                                 |
| `GET /api/summary`                           | Totais, cidades e última importação                                                                             |
| `GET /api/properties`                        | Lista paginada: `q`, `city`, `priority`, `status`, `minAge`, `maxAge`, `bbox`, `page`, `pageSize`, `active=all` |
| `GET /api/properties/:id`                    | Cadastro, geometria completa, visitas e retornos                                                                |
| `GET /api/map`                               | GeoJSON com pontos/grupos; requer `bbox=west,south,east,north` e `zoom`, aceita os filtros da lista             |
| `PATCH /api/properties/:id/prospect`         | `{status}`                                                                                                      |
| `POST /api/properties/:id/visits`            | `{result, notes?, occurredAt?}`; data opcional ISO, não futura                                                  |
| `GET /api/follow-ups`                        | Agenda e data atual de Utah                                                                                     |
| `POST /api/follow-ups`                       | `{propertyId, dueDate, notes?}`                                                                                 |
| `PATCH /api/follow-ups/:id`                  | `{dueDate?, state?, notes?}`                                                                                    |
| `POST /api/imports`                          | Iniciar carga com corpo JSON `{}`; retorna 202 e `{id}`                                                         |
| `GET /api/imports/:id`                       | Estado, progresso e erro da execução                                                                            |
| `GET /api/imports`                           | Últimas 15 execuções                                                                                            |
| `GET /api/data/issues`                       | Primeiros 100 registros com observações                                                                         |
| `POST /api/properties/:id/county`            | Relê o Parcel Search para um imóvel                                                                             |
| `GET /api/county-details`                    | Cobertura do Parcel Search e última execução                                                                    |
| `POST /api/county-details/runs`              | `{mode?: "missing" \| "refresh"}`; inicia a leitura em lote                                                     |
| `POST /api/county-details/runs/:id/stop`     | Interrompe a leitura em lote                                                                                    |
| `POST /api/properties/:id/photos/ticket`     | Assinatura de uso único para enviar uma foto ao Cloudinary                                                      |
| `POST /api/properties/:id/photos`            | `{publicId, version, signature, format, width?, height?, bytes?}`; grava a foto após conferir o comprovante     |
| `DELETE /api/properties/:id/photos/:photoId` | Apaga a foto no Cloudinary e no banco                                                                           |

## Limites desta entrega

Todos os usuários liberados têm o mesmo acesso (não há perfis de administrador ou representante). Sem fotos geradas, orçamentos, financiamento ou mensagens automáticas. A fonte GIS pode mudar ou ficar indisponível; o aplicativo preserva a última base completa. Prioridade por idade é a única classificação comercial automática.
