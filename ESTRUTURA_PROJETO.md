# Estrutura do projeto Extensionista

Este documento descreve a arquitetura, fluxo de dados, infraestrutura e principais pastas/arquivos do projeto. O objetivo e transformar diarios oficiais de Guarulhos em materias jornalisticas e exibi-las em um portal estatico.

## Visao geral

O sistema e composto por cinco partes principais:

- **lambda-watcher**: baixa o PDF mais recente do diario oficial, extrai o texto e grava no S3.
- **lambda-news-producer**: reage a novos textos no S3, gera uma materia com enquete via OpenAI e grava metadados no DynamoDB.
- **lambda-get-newsfeed**: expõe uma API HTTP para listar materias e obter o conteudo completo com enquete.
- **lambda-polls-manager**: gerencia votacoes em enquetes, processando votos e atualizando contadores no DynamoDB.
- **portal**: site estatico que consome a API, renderiza o feed, a pagina da materia e permite votacao em enquetes.

## Fluxo de dados (fim a fim)

```
[Diario oficial (PDF)]
          |
          v
lambda-watcher  --(texto extraido)-->  S3: diarios/diary-DDMMYYYY.txt
          |
          v
S3 evento (ObjectCreated)
          |
          v
lambda-news-producer  --(JSON da materia)-->  S3: materias/materia-YYYYMMDD.json
          |
          +--(metadados + enquete)--> DynamoDB: tabela materias
          |
          v
lambda-get-newsfeed  --(HTTP)--> API Gateway
          |                          (GET /feed, GET /materias/{pk})
          |
          +--> lambda-polls-manager  (POST /materias/{pk}/voto)
          |         |
          |         v
          |   DynamoDB: atualiza contadores de votos (ADD atomico)
          |
          v
portal (index.html / materia.html / app.js)
          |
          v
[Navegador: renderiza feed, materia e enquete com votacao]
```

## Componentes e responsabilidades

### 1) lambda-watcher

**Pasta**: [lambda-watcher](lambda-watcher)

**Responsabilidade**: localizar o diario oficial mais recente, baixar o PDF, extrair o texto e salvar no S3.

**Principais arquivos**:

- [lambda-watcher/lambda/src/app.ts](lambda-watcher/lambda/src/app.ts)
  - Faz scraping em `https://diariooficial.guarulhos.sp.gov.br/`.
  - Encontra o link PDF mais recente e baixa para `/tmp` (compativel com Lambda).
  - Extrai texto com `pdf-parse`.
  - Limita o texto a 500 KiB para manter o payload previsivel.
  - Envia o texto para o S3 em `diarios/diary-DDMMYYYY.txt`.

**Variaveis de ambiente relevantes** (infra):

- `S3_BUCKET_NAME`
- `AWS_REGION`

**Infraestrutura (Terraform)**:

- [lambda-watcher/infra/main.tf](lambda-watcher/infra/main.tf)
  - `aws_lambda_function` (runtime `nodejs24.x`).
  - `aws_scheduler_schedule` com cron `0 8,12,18 ? * MON-FRI *` e timezone `America/Sao_Paulo`.
  - Role dedicada do Scheduler e permissao `lambda:InvokeFunction` para invocar a Lambda.
  - `aws_cloudwatch_log_group` com retencao de 30 dias para os logs da funcao.
  - IAM com permissao de `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`.
  - Permissao basica de logs do Lambda.

### 2) lambda-news-producer

**Pasta**: [lambda-news-producer](lambda-news-producer)

**Responsabilidade**: processar o texto do diario, gerar uma materia com LLM e gravar o resultado no S3 e os metadados no DynamoDB.

**Principais arquivos**:

- [lambda-news-producer/lambda/src/app.ts](lambda-news-producer/lambda/src/app.ts)
  - E acionada por evento de criacao de objeto no S3 (prefixo `diarios/`).
  - Lê o arquivo de texto do diario.
  - Usa OpenAI com `zod` para validar o JSON da materia **e gerar automaticamente uma enquete com pergunta e opcoes**.
  - Salva a materia em `materias/materia-YYYYMMDD.json`.
  - Persiste metadados no DynamoDB com dois itens por materia:
    - Item com `SK='METADATA'`: dados basicos da materia.
    - Item com `SK='ENQUETE'`: pergunta, opcoes e contadores de votos inicializados em zero.

- [lambda-news-producer/lambda/src/secret.ts](lambda-news-producer/lambda/src/secret.ts)
  - Busca a chave da OpenAI via `Secrets Manager`.
  - Aceita segredo como string simples ou JSON com campos comuns (`OPENAI_API_KEY`, `apiKey`, etc.).

**Variaveis de ambiente relevantes** (infra):

- `OPENAI_SECRET_ID`
- `S3_BUCKET_NAME`
- `S3_REGION`
- `DDB_TABLE_NAME`

**Infraestrutura (Terraform)**:

- [lambda-news-producer/infra/main.tf](lambda-news-producer/infra/main.tf)
  - Cria a tabela DynamoDB (`PK`, `SK`) com GSI1 (`GSI1PK`, `GSI1SK`).
  - Configura notificacao do S3 para acionar a Lambda em `diarios/`.
  - IAM com permissao em S3, DynamoDB (`PutItem`) e Secrets Manager.

### 3) lambda-get-newsfeed

**Pasta**: [lambda-get-newsfeed](lambda-get-newsfeed)

**Responsabilidade**: expor a API de leitura do feed e de uma materia individual, incluindo dados de enquetes.

**Principais arquivos**:

- [lambda-get-newsfeed/lambda/src/app.ts](lambda-get-newsfeed/lambda/src/app.ts)
  - `GET /feed`: lista materias usando o GSI1, com paginação por cursor.
  - `GET /materias/{pk}`: faz Query por PK para recuperar METADATA e ENQUETE; retorna dados da materia + pergunta, opcoes e contadores de votos.
  - Normaliza PKs em formatos variados para `MATERIA#YYYYMMDD_001`.

**Variaveis de ambiente relevantes** (infra):

- `S3_BUCKET_NAME`
- `DDB_TABLE_NAME`

**Infraestrutura (Terraform)**:

- [lambda-get-newsfeed/infra/main.tf](lambda-get-newsfeed/infra/main.tf)
  - `aws_apigatewayv2_api` (HTTP API) com rotas `/feed` e `/materias/{pk}`.
  - Integracao proxy para a Lambda.
  - IAM com permissoes de leitura no DynamoDB e no S3.

### 4) lambda-polls-manager

**Pasta**: [lambda-polls-manager](lambda-polls-manager)

**Responsabilidade**: processar votos em enquetes, atualizar contadores atomicamente no DynamoDB e retornar o resultado da votacao.

**Principais arquivos**:

- [lambda-polls-manager/lambda/src/app.ts](lambda-polls-manager/lambda/src/app.ts)
  - E acionada por requisição `POST /materias/{pk}/voto` vinda do API Gateway.
  - Recebe o JSON com `{ opcao: 0 }` (indice da opcao escolhida).
  - Valida se a opcao existe na enquete.
  - Atualiza atomicamente o contador de votos usando `UpdateExpression: "ADD votos_opcao# :val"` no item `{ PK: pk, SK: 'ENQUETE' }`.
  - Retorna sucesso com o novo estado dos contadores.

**Variaveis de ambiente relevantes** (infra):

- `DDB_TABLE_NAME`

**Infraestrutura (Terraform)**:

- [lambda-polls-manager/infra/main.tf](lambda-polls-manager/infra/main.tf)
  - `aws_lambda_function` (runtime `nodejs24.x`).
  - Integracao com API Gateway existente: nova rota `/materias/{pk}/voto` com metodo `POST`.
  - Integracao *Lambda Proxy* apontando para esta funcao.
  - IAM com permissao de `dynamodb:UpdateItem` na tabela de materias.
  - Permissao `lambda:InvokeFunction` para o principal `apigateway.amazonaws.com`.
  - CORS configurado para aceitar requests do navegador.

### 5) portal

**Pasta**: [portal](portal)

**Responsabilidade**: renderizar o feed, a pagina da materia e a interface de votacao em enquetes.

**Principais arquivos**:

- [portal/index.html](portal/index.html)
  - Pagina do feed com botao de atualizar e carregar mais.
  - Define `window.__API_BASE_URL__` com o endpoint do API Gateway.

- [portal/materia.html](portal/materia.html)
  - Pagina da materia individual com area de conteudo.
  - Secao para exibir a enquete com opcoes de votacao (renderizada dinamicamente via app.js).

- [portal/app.js](portal/app.js)
  - Consome `GET /feed` e `GET /materias/{id}`.
  - Renderiza a lista de materias e converte Markdown basico em HTML.
  - Paginação via `nextCursor`.
  - **Novo**: Renderiza a enquete com botoes de votacao e contadores visuais.
  - **Novo**: Implementa bloqueio de votacao duplicada via `localStorage.getItem('voto_' + pk)`.
  - **Novo**: Envia `POST /materias/{pk}/voto` e desabilita interface apos sucesso.

## Modelo de dados

### DynamoDB (tabela de materias)

#### Item METADATA
- `PK`: `MATERIA#YYYYMMDD_001`
- `SK`: `METADATA`
- `GSI1PK`: `MATERIA`
- `GSI1SK`: timestamp ISO (ordem cronologica)
- Campos: `title`, `briefSummary`, `status`, `s3Path`

#### Item ENQUETE (novo)
- `PK`: `MATERIA#YYYYMMDD_001` (mesma PK que METADATA)
- `SK`: `ENQUETE`
- Campos:
  - `pergunta`: string com a pergunta da enquete
  - `opcoes`: array de strings com as opcoes disponiveis
  - `votos_opcao0`, `votos_opcao1`, `votos_opcao2`, etc.: contadores numericos inicializados em 0

### S3

- `diarios/diary-DDMMYYYY.txt` -> texto extraido do PDF.
- `materias/materia-YYYYMMDD.json` -> JSON com `title`, `date`, `content`, `briefSummary`.

## Endpoints da API

Baseados na Lambda `lambda-get-newsfeed` e `lambda-polls-manager`:

- `GET /feed`
  - Query: `limit`, `cursor`
  - Retorno: lista de metadados e `nextCursor`.

- `GET /materias/{pk}`
  - Retorno: metadados METADATA + conteudo completo do S3 + dados da enquete (pergunta, opcoes, contadores).

- `POST /materias/{pk}/voto`
  - Corpo: `{ opcao: 0 }`
  - Retorno: sucesso com novos contadores da enquete ou erro se opcao invalida.
  - Headers: `Content-Type: application/json`, CORS habilitado.

## Estrutura de pastas (resumo)

```
lambda-watcher/
  infra/
  lambda/
    src/app.ts

lambda-news-producer/
  infra/
  lambda/
    src/app.ts
    src/secret.ts

lambda-get-newsfeed/
  infra/
  lambda/
    src/app.ts

lambda-polls-manager/
  infra/
  lambda/
    src/app.ts

portal/
  infra/
  index.html
  materia.html
  app.js
  styles.css
```

## Observacoes de configuracao

- As Lambdas usam `nodejs24.x` e sao empacotadas a partir de `lambda/dist` (ver `infra/main.tf`).
- A `lambda-news-producer` usa `Secrets Manager` para a chave da OpenAI.
- A `lambda-watcher` e acionada automaticamente pelo EventBridge Scheduler em horarios comerciais, com idempotencia baseada na verificacao previa do objeto no S3.
- A `lambda-polls-manager` depende de acesso ao DynamoDB para atualizacoes atomicas.
- O portal depende do `window.__API_BASE_URL__` apontando para o endpoint do API Gateway.
- O portal usa `localStorage` para armazenar votos ja realizados e evitar duplicatas.

## Fluxo de votacao (end-to-end)

1. **Carregamento**: Portal faz `GET /materias/{pk}` e recebe pergunta, opcoes e contadores.
2. **Bloqueio local**: JavaScript verifica `localStorage.getItem('voto_' + pk)`; se existe, desabilita interface.
3. **Votacao**: Usuario clica em opcao; JavaScript envia `POST /materias/{pk}/voto` com indice da opcao.
4. **Atualizacao atomica**: Lambda atualiza `votos_opcao#` no DynamoDB usando ADD.
5. **Confirmacao**: Apos sucesso, portal armazena em `localStorage` e desabilita botoes.
