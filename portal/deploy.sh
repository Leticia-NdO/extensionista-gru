#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform não encontrado no PATH" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws (AWS CLI) não encontrado no PATH" >&2
  exit 1
fi

echo "Aplicando Terraform (bucket S3 do portal)..."
terraform -chdir=infra init -input=false
terraform -chdir=infra apply -auto-approve

BUCKET_NAME="$(terraform -chdir=infra output -raw bucket_name)"
WEBSITE_ENDPOINT="$(terraform -chdir=infra output -raw website_endpoint)"

echo "Sincronizando arquivos do portal para s3://$BUCKET_NAME ..."
aws s3 sync . "s3://$BUCKET_NAME" \
  --delete \
  --exclude "infra/*" \
  --exclude ".git/*" \
  --exclude ".terraform/*" \
  --exclude "*.tfstate*" \
  --exclude "tfplan" \
  --exclude "deploy.sh" \
  --exclude "*.md"

echo
echo "Deploy concluído."
echo "Bucket: $BUCKET_NAME"
echo "Site: http://$WEBSITE_ENDPOINT"
