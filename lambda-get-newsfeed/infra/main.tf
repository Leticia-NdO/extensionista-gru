terraform {
    required_version = ">= 1.0"
    required_providers {
        aws = {
            source  = "hashicorp/aws"
            version = "~> 6.19.0"
        }
        archive = {
            source  = "hashicorp/archive"
            version = "~> 2.0"
        }
    }
}

provider "aws" {
    region = var.region
}

data "aws_dynamodb_table" "materias" {
    name = var.dynamodb_table_name
}

# data "aws_subnet" "nat_public" {
#   id = var.nat_public_subnet_id
# }

data "archive_file" "lambda_zip" {
    type        = "zip"
    source_dir  = "${path.module}/../lambda/dist"
output_path = "${path.module}/../lambda.zip"
}

resource "aws_iam_role" "lambda_role" {
    name = "${var.function_name}-role"

    assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
            Sid: "StsAssumeLambdaRole",
            Action = "sts:AssumeRole",
            Effect = "Allow",
            Principal = {
                Service = "lambda.amazonaws.com"
            }
        }]
    })
}

resource "aws_iam_role_policy" "lambda_policy" {
    name = "${var.function_name}-policy"
    role = aws_iam_role.lambda_role.id
    policy = jsonencode({
        Version = "2012-10-17",
        Statement = [
            {
                Sid: "S3ReadAccess",
                Effect = "Allow",
                Action = [
                    "s3:GetObject",
                    "s3:ListBucket"
                ],
                Resource = [
                    "arn:aws:s3:::${var.s3_bucket_name}",
                    "arn:aws:s3:::${var.s3_bucket_name}/*"
                ]
            },
            {
                Sid: "DynamoDBReadAccess",
                Effect = "Allow",
                Action = [
                    "dynamodb:GetItem",
                    "dynamodb:Query"
                ],
                Resource = [
                    data.aws_dynamodb_table.materias.arn,
                    "${data.aws_dynamodb_table.materias.arn}/index/*"
                ]
            }
        ]
    })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
    role       = aws_iam_role.lambda_role.name
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "this" {
    filename         = data.archive_file.lambda_zip.output_path
    function_name    = var.function_name
    role             = aws_iam_role.lambda_role.arn
    handler          = "app.handler"
    runtime          = "nodejs24.x"
    source_code_hash = data.archive_file.lambda_zip.output_base64sha256
    publish          = true
    memory_size      = 512
    timeout          = 850
    environment {
      variables = {
        S3_BUCKET_NAME = var.s3_bucket_name
        DDB_TABLE_NAME = var.dynamodb_table_name
        API_ORIGIN_SECRET = var.api_origin_secret
      }
    }
}

resource "aws_apigatewayv2_api" "http_api" {
    name          = "${var.function_name}-api"
    protocol_type = "HTTP"

    cors_configuration {
        allow_origins = [var.cors_allow_origin]
        allow_methods = ["GET", "POST", "OPTIONS"]
        allow_headers = ["content-type", "authorization"]
        max_age       = 3600
    }
}

resource "aws_apigatewayv2_integration" "lambda" {
    api_id                 = aws_apigatewayv2_api.http_api.id
    integration_type       = "AWS_PROXY"
    integration_uri        = aws_lambda_function.this.arn
    payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "feed" {
    api_id    = aws_apigatewayv2_api.http_api.id
    route_key = "GET /api/feed"
    target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "materia" {
    api_id    = aws_apigatewayv2_api.http_api.id
    route_key = "GET /api/materias/{pk}"
    target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
    api_id      = aws_apigatewayv2_api.http_api.id
    name        = "$default"
    auto_deploy = true

    depends_on = [aws_apigatewayv2_route.feed, aws_apigatewayv2_route.materia]
}

resource "aws_lambda_permission" "allow_apigw_invoke" {
    statement_id  = "AllowExecutionFromAPIGateway"
    action        = "lambda:InvokeFunction"
    function_name = aws_lambda_function.this.function_name
    principal     = "apigateway.amazonaws.com"
    source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

// Attach the managed policy that allows Lambda to manage ENIs when placed in a VPC
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
    role       = aws_iam_role.lambda_role.name
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

output "lambda_name" {
    value = aws_lambda_function.this.function_name
}

output "lambda_arn" {
    value = aws_lambda_function.this.arn
}

output "api_base_url" {
    value = aws_apigatewayv2_api.http_api.api_endpoint
}

output "http_api_id" {
    value = aws_apigatewayv2_api.http_api.id
}

output "http_api_execution_arn" {
    value = aws_apigatewayv2_api.http_api.execution_arn
}
