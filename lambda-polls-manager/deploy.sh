#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Removing lambda.zip if it exists..."
if [ -f lambda.zip ]; then
  rm -f lambda.zip
  echo "Removed lambda.zip"
else
  echo "No lambda.zip found"
fi

echo "Building lambda (npm run build in lambda/)..."
if [ -d lambda ]; then
  npm --prefix lambda run build
else
  echo "lambda folder not found: $SCRIPT_DIR/lambda" >&2
  exit 1
fi

echo "Initializing Terraform in infra/..."
terraform -chdir=infra init -input=false

echo "Running terraform plan..."
terraform -chdir=infra plan -out=tfplan

echo "Applying terraform plan..."
terraform -chdir=infra apply -auto-approve tfplan

echo "Deploy script completed."
