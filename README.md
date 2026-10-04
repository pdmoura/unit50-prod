# Unit 50 · Fieldwork

Aplicativo de prospecção residencial em Weber County, Utah, com banco PostgreSQL e fotos dos imóveis no Cloudinary. Interface em inglês, com mapa de dados reais, prioridade por idade cadastral, histórico de visitas e agenda de retornos.

## Executar no Windows

Requisitos: **Node.js 24.15 ou superior da série 24**, com npm, e um banco **PostgreSQL**: o local do `docker-compose.yml` (Docker Desktop) ou um hospedado, como o Supabase.

Na pasta do projeto:

```powershell
Copy-Item .env.example .env   # ajuste DATABASE_URL, DATABASE_URL_DEV e as variáveis CLOUDINARY_*
npm run db:up                 # só para o banco local em Docker (porta 54350)
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
2. Na pasta do projeto: `npx tsx scripts/allow-user.ts pessoa@empresa.com` (acrescente `--dev` para o banco local, `--remove` para retirar o acesso, `--list` para ver quem está liberado).

Sem essas duas variáveis o aplicativo roda sem login e aceita conexões apenas da própria máquina; o servidor se recusa a iniciar num endereço público nessa condição.

## Publicação (Render)

`render.yaml` descreve o serviço: Node, região Oregon (ao lado do banco no Supabase), build `npm ci --include=dev && npm run build`, início `npm start`, verificação em `/api/health`. As variáveis `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` e `CLOUDINARY_*` são definidas no painel do Render. Cada push na branch `main` gera um novo deploy. A importação do condado e a leitura em lote do Parcel Search são pesadas para uma instância pequena; rode-as do seu computador com `npm start` (mesmo banco).

## Fotos do imóvel (Cloudinary)

Na ficha do imóvel, **Add photo** abre a câmera ou a galeria. O arquivo vai direto do navegador para o Cloudinary, com uma assinatura de uso único emitida pelo servidor; o segredo da API nunca chega ao navegador. O Cloudinary devolve um comprovante assinado, que o servidor confere antes de gravar a foto em `property_photos`. Remover a foto apaga primeiro a imagem no Cloudinary e depois o registro.

- Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` e, se quiser, `CLOUDINARY_FOLDER` (padrão `unit50-uploads`). Sem essas variáveis, o botão de fotos não aparece.
- Use uma chave restrita à pasta. `scripts/cloudinary-folder-access.mjs` concede o papel Manager nessa pasta (ver comentários no arquivo).
- Limites: 30 fotos por imóvel, 15 MB por arquivo, formatos JPG, PNG, WebP e HEIC.

## Banco, backup e recuperação

Banco PostgreSQL definido em `DATABASE_URL` (produção) ou `DATABASE_URL_DEV` (desenvolvimento, com `--dev`). As migrações ficam em `server/migrations.ts`, são registradas na tabela `schema_migrations` e aplicadas ao iniciar o servidor. Não apague o banco para atualizar os dados.

Banco local (Docker): `npm run db:up` cria o Postgres em `127.0.0.1:54350` com volume persistente. Para uma cópia de segurança:

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
- Testes unitários e de integração: prioridades e frações, datas, IDs, geometrias, conflitos, carga incompleta, parcelas inativas, bloqueio de contato, validação de API, filtros, persistência após reinício do servidor, páginas do Parcel Search e fotos (assinatura, conferência do comprovante e remoção) com um Cloudinary simulado.
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
