# Extensionista

Projeto que transforma diarios oficiais de Guarulhos em materias jornalisticas e publica um portal estatico com feed e enquetes.

## Visao geral

Componentes principais:

- **lambda-watcher**: baixa o PDF do diario oficial, extrai texto e grava no S3.
- **lambda-news-producer**: gera materia + enquete com LLM e grava metadados no DynamoDB.
- **lambda-get-newsfeed**: expõe API para feed e materia individual.
- **lambda-polls-manager**: processa votos e atualiza contadores no DynamoDB.
- **portal**: front-end estatico que consome a API e renderiza feed e enquetes.

## Estrutura

- [lambda-watcher](lambda-watcher)
- [lambda-news-producer](lambda-news-producer)
- [lambda-get-newsfeed](lambda-get-newsfeed)
- [lambda-polls-manager](lambda-polls-manager)
- [portal](portal)

Para detalhes completos, consulte [ESTRUTURA_PROJETO.md](ESTRUTURA_PROJETO.md).

## Configuracao (alto nivel)

Variaveis de ambiente relevantes usadas pelas Lambdas (definidas na infra):

- `S3_BUCKET_NAME`
- `AWS_REGION`
- `OPENAI_SECRET_ID`
- `S3_REGION`
- `DDB_TABLE_NAME`

O portal depende de `window.__API_BASE_URL__` apontando para o endpoint do API Gateway.

## Infraestrutura

Cada pasta de lambda possui um diretório `infra/` com Terraform. Os arquivos de estado e variaveis sao considerados sensiveis e ficam fora do Git.

## Deploy

Cada componente possui um `deploy.sh` para facilitar o deploy manual. Execute-os com cuidado e com as credenciais AWS configuradas.

## Seguranca

O repositorio ignora:

- estados e variaveis do Terraform
- arquivos de ambiente e chaves
- caches e artefatos de build

Veja [/.gitignore](.gitignore) para a lista completa.
